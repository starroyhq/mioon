import { ClipLutRecoveryError } from './clip-lut-recovery.ts';
import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/types.ts';

/** Display metadata is in-memory only. The legacy diagnostic is retained for
 * compatibility, never used to choose behavior or sent in business inputs. */
export class TimelineUiError extends Error {
  readonly displayMessage: DisplayMessage;
  constructor(displayMessage: DisplayMessage) {
    super(renderMessage('zh-Hans', displayMessage));
    this.name = 'TimelineUiError'; this.displayMessage = displayMessage;
  }
}
export function timelineErrorMessage(error: unknown, fallback: DisplayMessage): DisplayMessage {
  if (error instanceof TimelineUiError) return error.displayMessage;
  // Recovery errors are application-owned typed codes; no diagnostic matching.
  if (error instanceof ClipLutRecoveryError) {
    switch (error.code) {
      case 'LUT_RECOVERY_UNAVAILABLE': return message('colour.recovery.unavailable');
      case 'LUT_RECOVERY_CONFLICT': return message('colour.recovery.conflict');
      case 'LUT_RECOVERY_CORRUPT': return message('colour.recovery.corrupt');
    }
  }
  return fallback;
}
export function timelineFailure<K extends string>(field: K, error: unknown, fallback: DisplayMessage): Record<K, string> & Record<`${K}Message`, DisplayMessage> {
  return { [field]: error instanceof Error ? error.message : renderMessage('zh-Hans', fallback),
    [`${field}Message`]: timelineErrorMessage(error, fallback) } as Record<K, string> & Record<`${K}Message`, DisplayMessage>;
}
