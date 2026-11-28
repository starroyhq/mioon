import {AppError} from '../../contracts/src/app-error.ts';
import {FORMAT5_LIMITS} from '../../contracts/src/project-format5.ts';
import {sequenceEditDialogueConflictSchema, sequenceEditFailureEvidenceSchema,
  type SequenceEditDialogueConflict, type SequenceEditFailureEvidence} from '../../contracts/src/sequence-edit.ts';
import {sequenceEditFailureMessageKey, translate} from '../../i18n/src/index.ts';
import type {Locale} from '../../i18n/src/types.ts';

export interface SequenceEditPreviewFailure {
  readonly ok: false;
  readonly code: string;
  readonly ids: readonly string[];
  readonly reason?: string;
  readonly message?: string;
  readonly messageKey?: ReturnType<typeof sequenceEditFailureMessageKey>;
  readonly dialogueConflict?: SequenceEditDialogueConflict;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const reasonCode = /^[A-Z][A-Z0-9_]{0,79}$/u;

export function sequenceEditFailureMessage(code: string, reason?: string, locale: Locale = 'zh-Hans'): string | undefined {
  const key = sequenceEditFailureMessageKey(code, reason);
  return key ? translate(locale, key) : undefined;
}

/** Carry only bounded identities and machine reason codes outside the planner. */
export function sequenceEditFailureEvidence(code: string, details: unknown): SequenceEditFailureEvidence | undefined {
  if (!sequenceEditFailureMessageKey(code) || !details || typeof details !== 'object') return undefined;
  const {ids, reason} = details as {ids?: unknown; reason?: unknown};
  const evidence = sequenceEditFailureEvidenceSchema.safeParse({
    ids: Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string' && uuid.test(id)))]
      .slice(0, FORMAT5_LIMITS.mainTrackClips) : [],
    ...(typeof reason === 'string' && reasonCode.test(reason) ? {reason} : {}),
  });
  return evidence.success && (evidence.data.ids.length > 0 || evidence.data.reason) ? evidence.data : undefined;
}

export function explainSequenceEditFailure(failure: SequenceEditPreviewFailure, locale?: Locale): SequenceEditPreviewFailure {
  if (failure.message) return failure;
  const messageKey = sequenceEditFailureMessageKey(failure.code, failure.reason);
  return messageKey ? {...failure, message: translate(locale ?? 'zh-Hans', messageKey), messageKey} : failure;
}

export function dialogueConflictMessage(conflict: SequenceEditDialogueConflict, copying = false): string {
  const lead = copying ? '副本的台词放不进去。' : '这几句台词放不进去。';
  const space = `至少需要 ${conflict.requiredFrames} 帧，这段时间只剩 ${conflict.availableFrames} 帧。`;
  const action = copying ? '再复制' : '后再试';
  if (conflict.blockerCount === 0) return `${lead}${space}延长片段或减少台词${action}。`;
  const text = conflict.blockers[0]?.textExcerpt;
  const existing = text ? `这段时间已有字幕「${text}」${conflict.blockerCount > 1 ? '等' : ''}。` : '这段时间已有字幕。';
  return `${lead}${existing}${space}先挪开或删掉挡住的字幕${action}。`;
}

/** Only validation errors can supply text to the external action and Mio tool result. */
export function sequenceEditPreviewFailure(error: AppError, ids?: readonly string[]): SequenceEditPreviewFailure {
  const details = error.details as {ids?: unknown; reason?: unknown; dialogueConflict?: unknown} | undefined;
  const reason = details?.reason;
  const targetIds = ids ?? (Array.isArray(details?.ids) ? details.ids.filter(id => typeof id === 'string') : []);
  const conflict = error.code === 'SEQUENCE_EDIT_DIALOGUE_CONFLICT'
    ? sequenceEditDialogueConflictSchema.safeParse(details?.dialogueConflict) : undefined;
  return {ok: false, code: error.code, ids: targetIds, ...(conflict?.success ? {dialogueConflict: conflict.data} : {}),
    ...(typeof reason === 'string' && reason ? {reason} : {}),
    ...(error.status >= 400 && error.status < 500 && error.message ? {message: error.message} : {})};
}

/** A user-facing failure from the read-only phase of a bounded sequence action. */
export class MioSequencePreviewRejection extends AppError {}

/** The domain transaction confirmed this commit did not apply its changes. */
export class SequenceEditCommitRejection extends AppError {}

export function sequenceEditCommitError(failure: Omit<SequenceEditPreviewFailure, 'ok'>,
  fallback: string, locale?: Locale): AppError {
  const {code, ids, reason, dialogueConflict} = failure;
  const messageKey = sequenceEditFailureMessageKey(code, reason);
  if (!messageKey) return new AppError(code, failure.message ?? fallback, 409,
    {ids, ...(dialogueConflict ? {dialogueConflict} : {})});
  const evidence = sequenceEditFailureEvidence(code, failure) ?? {ids: []};
  const message = failure.message ?? translate(locale ?? 'zh-Hans', messageKey);
  return new SequenceEditCommitRejection(code, message, 409,
    failure.message ? evidence : {...evidence, messageKey});
}
