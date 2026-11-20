/** DL-b: plan one format-5 shot's dialogue prompt and freeze the exact text.
 *
 * The shot's ordered dialogue rows are authoritative (DL-a). A speaking service
 * gets those lines written into the prompt with its reviewed style; a service
 * without a reviewed speaking capability gets no dialogue at all and a stable
 * reason the panel and the read-only projection can show. The composed raw text
 * is what the job snapshot records, so a retry can never re-compose a different
 * prompt after the shot or the service selection changed.
 */
import {AppError} from '../../contracts/src/app-error.ts';
import type {DatabaseSync} from 'node:sqlite';
import {
  composeDialoguePrompt, dialogueAudioRequest, dialogueGenerationCapability,
  DIALOGUE_GENERATION_PROFILE_VERSION,
} from '../../contracts/src/dialogue-generation.ts';
import type {
  DialogueDeliveryStyle, DialogueGenerationCapability, DialoguePromptLine, DialogueAudioMode,
} from '../../contracts/src/dialogue-generation.ts';
import {format5DialogueSchema} from '../../contracts/src/project-format5.ts';
import type {SequenceGenerationDialogueView} from '../../contracts/src/sequence-inspection.ts';
import {videoInputProfile} from '../../contracts/src/video-providers.ts';
import type {VideoExecutionBinding} from '../../contracts/src/video-providers.ts';
import type {ProjectStore} from './project-file/store.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';

type Row = Record<string, unknown>;

export const FORMAT5_DIALOGUE_REASONS = Object.freeze({
  serviceNotSelected: 'SERVICE_NOT_SELECTED',
  serviceDoesNotSpeak: 'SERVICE_DOES_NOT_SPEAK',
  audioOff: 'AUDIO_OFF',
  promptTooLong: 'PROMPT_TOO_LONG',
} as const);
export type Format5DialogueReason = typeof FORMAT5_DIALOGUE_REASONS[keyof typeof FORMAT5_DIALOGUE_REASONS];

export interface Format5DialogueLineFreeze {
  readonly lineId: string;
  readonly text: string;
  readonly speakerName?: string;
}

export interface Format5DialoguePlan {
  readonly version: 1;
  readonly shotId: string;
  readonly shotRevision: number;
  readonly binding: {readonly providerId: string; readonly modelEntryId: string; readonly modelId: string;
    readonly templateId: string; readonly audio: string} | null;
  readonly status: SequenceGenerationDialogueView['status'];
  readonly reason?: Format5DialogueReason;
  readonly lines: readonly Format5DialogueLineFreeze[];
  readonly basePrompt: string;
  /** Composed outgoing prompt; equals `basePrompt` unless dialogue is used. */
  readonly prompt: string;
  readonly promptCodeUnits: number;
  readonly maxPromptCodeUnits: number;
  readonly capability: DialogueGenerationCapability | null;
  /** The adapter's native-audio request field when this model needs one. */
  readonly audioRequest: {readonly generateAudio: true} | null;
  /** The switch value this generation actually uses (explicit user choice or the
   * dialogue default), recorded in the freeze even when no dialogue is sent. */
  readonly generateAudio: boolean;
}

/** Frozen plan a job snapshot stores; immutable generation provenance. */
export interface Format5DialogueFreeze {
  readonly version: 1;
  readonly profileVersion: string;
  readonly shotId: string;
  readonly shotRevision: number;
  readonly providerId: string;
  readonly modelEntryId: string;
  readonly modelId: string;
  readonly templateId: string;
  readonly status: SequenceGenerationDialogueView['status'];
  readonly reason?: Format5DialogueReason;
  readonly style?: DialogueDeliveryStyle;
  readonly audioMode?: DialogueAudioMode;
  readonly lines: readonly Format5DialogueLineFreeze[];
  readonly basePrompt: string;
  readonly prompt: string;
  readonly promptCodeUnits: number;
  readonly maxPromptCodeUnits: number;
  readonly generateAudio: boolean;
}

export function format5DialogueGeneration(store: ProjectStore): boolean {
  return Number(store.db.prepare('PRAGMA project.user_version').get()?.user_version) === FORMAT5_PROJECT_SCHEMA_VERSION;
}

function readShot(store: ProjectStore, shotId: string): {data: Row; revision: number} {
  const row = store.db.prepare('SELECT data FROM project.shots WHERE id=? AND projectId=?')
    .get(shotId, store.projectId) as {data?: unknown} | undefined;
  if (!row || typeof row.data !== 'string') throw new AppError('SEQUENCE_EDIT_DIALOGUE_INVALID', '镜头不存在。', 409, {shotId});
  let data: unknown;
  try { data = JSON.parse(row.data); } catch { throw new AppError('SEQUENCE_EDIT_DIALOGUE_INVALID', '镜头内容无效。', 409, {shotId}); }
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    throw new AppError('SEQUENCE_EDIT_DIALOGUE_INVALID', '镜头内容无效。', 409, {shotId});
  // Shot revision is carried by the agent target table; the planner only needs it
  // for provenance, and the job snapshot records the verified revision separately.
  const target = store.db.prepare("SELECT revision FROM project.agent_task_target_revisions_v2 WHERE projectId=? AND kind='shot' AND targetId=?")
    .get(store.projectId, shotId) as {revision?: unknown} | undefined;
  return {data: data as Row, revision: Number.isSafeInteger(target?.revision) ? Number(target!.revision) : 1};
}

/** Resolved speaker display names for one shot's dialogue rows. A missing subject
 * row is treated as "no speaker name" rather than inventing one. */
function speakerNames(store: ProjectStore, dialogue: readonly {readonly speakerSubjectId?: string}[]): Map<string, string> {
  const ids = [...new Set(dialogue.flatMap(line => line.speakerSubjectId ? [line.speakerSubjectId] : []))];
  const names = new Map<string, string>();
  for (const id of ids) {
    const row = store.db.prepare('SELECT name FROM project.subjects WHERE id=? AND projectId=?')
      .get(id, store.projectId) as {name?: unknown} | undefined;
    if (typeof row?.name === 'string' && row.name.length > 0) names.set(id, row.name);
  }
  return names;
}

export interface PlanFormat5DialogueOptions {
  readonly binding?: VideoExecutionBinding;
  /** Saved shot prompt; the text the user already wrote for this shot. */
  readonly basePrompt: string;
  /** Explicit request switch; omitted means the dialogue default. */
  readonly generateAudio?: boolean;
}

export interface PlanDialogueGenerationInput {
  readonly shotId: string;
  readonly shotRevision: number;
  /** Validated shot dialogue rows plus the display names of their speakers. */
  readonly lines: readonly Format5DialogueLineFreeze[];
  readonly basePrompt: string;
  readonly binding?: VideoExecutionBinding;
  /** Explicit "生成声音" switch from the request; omitted means the service
   * default (open when the shot has dialogue and the model's audio is optional). */
  readonly generateAudio?: boolean;
}

/** Pure dialogue plan for one already-read shot. Never writes and never throws
 * for a rejected/unsupported outcome: the caller turns a `rejected` plan into the
 * submit-time error and the projection reports it to the panel. */
export function planDialogueGeneration(input: PlanDialogueGenerationInput): Format5DialoguePlan {
  const {shotId, shotRevision, lines, basePrompt} = input;
  const binding = input.binding ?? null;
  if (!binding) {
    return {version: 1, shotId, shotRevision, binding: null, status: 'unsupported',
      reason: FORMAT5_DIALOGUE_REASONS.serviceNotSelected, lines, basePrompt, prompt: basePrompt,
      promptCodeUnits: basePrompt.length, maxPromptCodeUnits: 0, capability: null, audioRequest: null,
      generateAudio: false};
  }
  const capability = dialogueGenerationCapability(binding);
  const maxPromptCodeUnits = videoInputProfile(binding).prompt.maxCodeUnits;
  const bindingFreeze = {providerId: binding.providerId, modelEntryId: binding.model.id,
    modelId: binding.model.modelId, templateId: binding.model.templateId, audio: binding.model.audio};
  if (!capability) {
    return {version: 1, shotId, shotRevision, binding: bindingFreeze, status: 'unsupported',
      reason: FORMAT5_DIALOGUE_REASONS.serviceDoesNotSpeak, lines, basePrompt, prompt: basePrompt,
      promptCodeUnits: basePrompt.length, maxPromptCodeUnits, capability: null, audioRequest: null,
      generateAudio: false};
  }
  // The optional native-sound switch follows the explicit request first; without
  // one the dialogue default opens it, so the UI checkbox and request agree.
  const generateAudio = capability.audioMode === 'request-switch'
    ? input.generateAudio ?? lines.length > 0
    : capability.audioMode !== 'model-default' && capability.audioMode !== 'always-on' ? false : true;
  // Only a shot that actually has lines loses dialogue when sound is off.
  const audioOff = capability.audioMode === 'request-switch' && !generateAudio && lines.length > 0;
  if (audioOff) {
    // The user turned sound off: this generation sends no dialogue at all.
    return {version: 1, shotId, shotRevision, binding: bindingFreeze, status: 'unsupported',
      reason: FORMAT5_DIALOGUE_REASONS.audioOff, lines, basePrompt, prompt: basePrompt,
      promptCodeUnits: basePrompt.length, maxPromptCodeUnits, capability, audioRequest: null,
      generateAudio: false};
  }
  const promptLines: readonly DialoguePromptLine[] = lines;
  const composed = composeDialoguePrompt(basePrompt, promptLines, capability.style);
  const baseFits = basePrompt.length <= maxPromptCodeUnits;
  // Reject as dialogue-caused only when the original prompt fits and the added
  // lines push it over. An over-long original prompt stays a prompt-validation
  // error; without lines there is nothing to blame on the dialogue.
  if (lines.length > 0 && baseFits && composed.length > maxPromptCodeUnits) {
    return {version: 1, shotId, shotRevision, binding: bindingFreeze, status: 'rejected',
      reason: FORMAT5_DIALOGUE_REASONS.promptTooLong, lines, basePrompt, prompt: composed,
      promptCodeUnits: composed.length, maxPromptCodeUnits, capability, audioRequest: null,
      generateAudio};
  }
  const prompt = baseFits ? composed : basePrompt;
  return {version: 1, shotId, shotRevision, binding: bindingFreeze, status: 'used',
    lines, basePrompt, prompt, promptCodeUnits: prompt.length, maxPromptCodeUnits, capability,
    audioRequest: capability.audioMode === 'request-switch' && generateAudio ? dialogueAudioRequest(capability) : null,
    generateAudio};
}

/** Read one format-5 shot, validate its dialogue rows and resolve speaker names;
 * the pure planner above owns the reviewed prompt rules. */
export function planFormat5DialogueGeneration(store: ProjectStore, shotId: string,
  options: PlanFormat5DialogueOptions): Format5DialoguePlan {
  const shot = readShot(store, shotId);
  const parsed = format5DialogueSchema.safeParse(shot.data.dialogue ?? []);
  if (!parsed.success) throw new AppError('SEQUENCE_EDIT_DIALOGUE_INVALID', '镜头台词内容无效。', 409, {shotId});
  const dialogue = parsed.data;
  const names = speakerNames(store, dialogue);
  const lines: Format5DialogueLineFreeze[] = dialogue.map(line => ({
    lineId: line.id, text: line.text,
    ...(line.speakerSubjectId && names.has(line.speakerSubjectId) ? {speakerName: names.get(line.speakerSubjectId)!} : {}),
  }));
  return planDialogueGeneration({shotId, shotRevision: shot.revision, lines,
    basePrompt: options.basePrompt, ...(options.binding ? {binding: options.binding} : {}),
    ...(options.generateAudio !== undefined ? {generateAudio: options.generateAudio} : {})});
}

export function freezeFormat5Dialogue(plan: Format5DialoguePlan): Format5DialogueFreeze {
  const capability = plan.capability;
  return {version: 1, profileVersion: DIALOGUE_GENERATION_PROFILE_VERSION,
    shotId: plan.shotId, shotRevision: plan.shotRevision,
    providerId: plan.binding?.providerId ?? '', modelEntryId: plan.binding?.modelEntryId ?? '',
    modelId: plan.binding?.modelId ?? '', templateId: plan.binding?.templateId ?? '',
    status: plan.status, ...(plan.reason ? {reason: plan.reason} : {}),
    ...(capability ? {style: capability.style, audioMode: capability.audioMode} : {}),
    lines: plan.lines, basePrompt: plan.basePrompt, prompt: plan.prompt,
    promptCodeUnits: plan.promptCodeUnits, maxPromptCodeUnits: plan.maxPromptCodeUnits,
    generateAudio: plan.generateAudio};
}

/** Frozen provenance from a job snapshot. Absent for format 3/4 jobs or format-5
 * jobs created before this path was implemented. */
export function readFrozenFormat5Dialogue(snapshot: unknown): Format5DialogueFreeze | null {
  if (snapshot === null || typeof snapshot !== 'object') return null;
  const value = (snapshot as Row).format5Dialogue;
  return value !== null && typeof value === 'object' && (value as Row).version === 1
    ? value as unknown as Format5DialogueFreeze : null;
}

/** Read-only status shared by the property panel and `sequence.generation-inputs.get`. */
export function format5DialogueView(plan: Format5DialoguePlan): SequenceGenerationDialogueView {
  const capability = plan.capability;
  return {status: plan.status, lineCount: plan.lines.length, ...(plan.reason ? {reason: plan.reason} : {}),
    promptCodeUnits: plan.promptCodeUnits, maxPromptCodeUnits: plan.maxPromptCodeUnits,
    ...(capability ? {style: capability.style, audioMode: capability.audioMode,
      docs: capability.docs} : {})};
}

/** Submit-time rejection for a plan the service cannot accept. Never truncates. */
export function assertFormat5DialogueSubmittable(plan: Format5DialoguePlan): void {
  if (plan.status !== 'rejected') return;
  throw new AppError('DIALOGUE_PROMPT_TOO_LONG',
    '台词加进提示词后超出这个服务的上限。', 400,
    {shotId: plan.shotId, promptCodeUnits: plan.promptCodeUnits, maxPromptCodeUnits: plan.maxPromptCodeUnits,
      reason: FORMAT5_DIALOGUE_REASONS.promptTooLong});
}
