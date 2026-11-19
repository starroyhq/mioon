import {message,translate} from '../../../packages/i18n/src/index.ts';
import type {DisplayMessage} from '../../../packages/i18n/src/index.ts';

/** A settings save always captures the exact expected revision, the canonical
 * request body and the expected secret state before dispatch. A lost response
 * is answered only by reading the same settings back and comparing all three;
 * a conflict rejection is a definite non-application, anything else that does
 * not reproduce the full acknowledgement stays unknown. */
export interface SettingsRecoveryExpectation {
  readonly revision: number;
  readonly fingerprint: string;
  readonly secret: {readonly configured: boolean;readonly storage: string}|null;
  readonly secretReplaced: boolean;
  readonly conflict: boolean;
}
export interface SettingsRecoveryReadback {
  readonly revision: number;
  readonly fingerprint: string|null;
  readonly secret: {readonly configured: boolean;readonly storage: string}|null;
}
export type SettingsRecoveryVerdict='applied'|'not_applied'|'unknown';

export function settingsRecoveryVerdict(readback: SettingsRecoveryReadback,expected: SettingsRecoveryExpectation): SettingsRecoveryVerdict {
  // A CAS rejection is a definite non-application; a coincidentally equal
  // body must never be reported as applied after the server refused it.
  if (expected.conflict) return 'not_applied';
  if (readback.revision !== expected.revision + 1) return 'unknown';
  if (readback.fingerprint !== expected.fingerprint) return 'unknown';
  if (expected.secret && (readback.secret?.configured !== expected.secret.configured || readback.secret?.storage !== expected.secret.storage)) return 'unknown';
  return 'applied';
}

/** A retry is only offered for an unknown outcome whose request carried no
 * replacement secret: the secret bytes are gone from memory, so the user must
 * enter them again instead of sending a different request. */
export const settingsRecoveryRetryable=(verdict: SettingsRecoveryVerdict,secretReplaced: boolean): boolean=>verdict==='unknown'&&!secretReplaced;

export function settingsRecoveryMessages(verdict: SettingsRecoveryVerdict,secretReplaced: boolean): DisplayMessage[] {
  const primary=verdict==='not_applied'?'connections.recovery.notSavedConflict':'connections.recovery.notSavedUnknown';
  return [message(primary),...(secretReplaced?[message('connections.recovery.keyRequired')]:[])];
}
export const settingsRecoveryMessageText=(verdict: SettingsRecoveryVerdict,secretReplaced: boolean): string =>
  translate('zh-Hans',verdict==='not_applied'?'connections.recovery.notSavedConflict':'connections.recovery.notSavedUnknown');
