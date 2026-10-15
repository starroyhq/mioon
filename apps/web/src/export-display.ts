import { translate } from '../../../packages/i18n/src/index.ts';
import type { Locale } from '../../../packages/i18n/src/index.ts';
const statusKeys = {
  queued: 'export.status.queued', submitting: 'export.status.submitting', running: 'export.status.running', downloading: 'export.status.downloading',
  succeeded: 'export.status.succeeded', failed: 'export.status.failed', submission_unknown: 'export.status.submission_unknown',
  cancelled: 'export.status.cancelled', ready: 'export.status.ready', pending: 'export.status.pending', completed: 'export.status.completed',
} as const;
/** Backend status codes and history are immutable; only the display is localized. */
export function exportHistoryStatusMessage(status: unknown, locale: Locale): string {
  return translate(locale, typeof status === 'string' && Object.hasOwn(statusKeys, status) ? statusKeys[status as keyof typeof statusKeys] : 'export.status.unknown');
}
