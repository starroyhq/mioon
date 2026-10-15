import { message } from '../../../packages/i18n/src/index.ts';
import type { MessageDescriptor } from '../../../packages/i18n/src/index.ts';

const localErrors = new WeakMap<Error, MessageDescriptor>();
export function recoveryDisplayError<T extends Error>(error: T, descriptor: MessageDescriptor): T { localErrors.set(error, descriptor); return error; }

/** App-owned display metadata only. Never copied to recovery requests or files. */
export function recoveryErrorMessage(error: unknown): MessageDescriptor {
  if (error instanceof Error && localErrors.has(error)) return localErrors.get(error)!;
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const code = typeof value?.code === 'string' ? value.code : '';
  if (code === 'LOCAL_DELIVERY_LOCAL_VALIDATION') return message('recovery.delivery.localInvalid');
  if (code === 'LOCAL_DELIVERY_LOCAL_RETRY_LIMIT') return message('recovery.delivery.localRetryLimit');
  if (code === 'LOCAL_SHOT_TEXT_LOCAL_VALIDATION') return message('recovery.text.localInvalid');
  if (code === 'LOCAL_SHOT_TEXT_LOCAL_RETRY_LIMIT') return message('recovery.text.localRetryLimit');
  if (code === 'LOCAL_DRAFT_WRITE_UNSUPPORTED') return message('recovery.clip.unsupported');
  if (code.endsWith('_TIMEOUT_UNKNOWN')) return message('recovery.notice.timeout');
  if (code.endsWith('_NETWORK_UNKNOWN')) return message('recovery.notice.network');
  if (code.endsWith('_PROTOCOL_UNKNOWN') || code === 'BACKEND_PROTOCOL_ERROR') return message('recovery.notice.protocol');
  if (code.endsWith('_CAPACITY')) return message('recovery.notice.capacity');
  if (code.endsWith('_CONFLICT') || code.includes('IDENTITY') || code.includes('WORKSPACE')) return message('recovery.notice.conflict');
  return message('recovery.notice.unconfirmed');
}
