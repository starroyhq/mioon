import {AppError} from '../../contracts/src/app-error.ts';
import {sequenceEditDialogueConflictSchema} from '../../contracts/src/sequence-edit.ts';
import type {SequenceEditDialogueConflict} from '../../contracts/src/sequence-edit.ts';

export interface SequenceEditPreviewFailure {
  readonly ok: false;
  readonly code: string;
  readonly ids: readonly string[];
  readonly reason?: string;
  readonly message?: string;
  readonly dialogueConflict?: SequenceEditDialogueConflict;
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
