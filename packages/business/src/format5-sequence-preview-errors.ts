import {AppError} from '../../contracts/src/app-error.ts';

export interface SequenceEditPreviewFailure {
  readonly ok: false;
  readonly code: string;
  readonly ids: readonly string[];
  readonly reason?: string;
  readonly message?: string;
}

/** Only validation errors can supply text to the external action and Mio tool result. */
export function sequenceEditPreviewFailure(error: AppError, ids?: readonly string[]): SequenceEditPreviewFailure {
  const details = error.details as {ids?: unknown; reason?: unknown} | undefined;
  const reason = details?.reason;
  const targetIds = ids ?? (Array.isArray(details?.ids) ? details.ids.filter(id => typeof id === 'string') : []);
  return {ok: false, code: error.code, ids: targetIds,
    ...(typeof reason === 'string' && reason ? {reason} : {}),
    ...(error.status >= 400 && error.status < 500 && error.message ? {message: error.message} : {})};
}

/** A user-facing failure from the read-only phase of a bounded sequence action. */
export class MioSequencePreviewRejection extends AppError {}
