import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
// Bound untrusted filenames and never interpolate provider diagnostics into a
// primary notice. Descriptors retain request-time facts across language changes.
interface NamedFile {name: string}
interface ImportStop {kind?: 'local' | 'rejected' | 'unknown' | string; reason?: unknown}
function displayText(value: unknown, limit = 64): string {
  const original = String(value || '');
  const characters = Array.from(original.slice(0, limit * 4).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' '));
  return characters.slice(0, limit).join('') + (original.length > limit * 4 || characters.length > limit ? '…' : '');
}
function fileNames(files: readonly NamedFile[]): string { return files.slice(0, 3).map(file => `「${displayText(file.name)}」`).join('、') + (files.length > 3 ? ' …' : ''); }
export function importBusyFeedback(files: readonly NamedFile[]) {
  return message('assets.importBusy', { count: files.length, files: fileNames(files) });
}
export function importFeedback(files: readonly NamedFile[], done: number, stopped: ImportStop | null = null) {
  const confirmed = { count: done, files: fileNames(files.slice(0, done)) };
  if (!stopped) return message('assets.importComplete', confirmed);
  const descriptor = message(stopped.kind === 'local' ? 'assets.importLocalFailed' : stopped.kind === 'rejected' ? 'assets.importRejected' : 'assets.importUnknown', {
    ...confirmed, current: fileNames(files.slice(done, done + 1)), remaining: files.slice(done + 1).length, unattempted: fileNames(files.slice(done + 1)), omitted: Math.max(0, done - 3), unattemptedOmitted: Math.max(0, files.length - done - 4),
  });
  return stopped.reason && typeof stopped.reason === 'object' ? Object.freeze({ ...descriptor, detail: stopped.reason }) : descriptor;
}
export function renderImportFeedback(locale: Parameters<typeof renderMessage>[0], value: Parameters<typeof renderMessage>[1] & {detail?: unknown} | null | undefined): string {
  return renderMessage(locale, value) + (value?.detail ? ` ${renderMessage(locale, value.detail as Parameters<typeof renderMessage>[1])}` : '');
}
// asset.import already returns this asset identity. This is a narrow check of
// its existing response, not a new receipt, replay key or recovery protocol.
export function importAcknowledged(asset: unknown, input: {projectId?: unknown; name?: unknown; mimeType?: unknown}): boolean {
  const value = asset as {id?: unknown; projectId?: unknown; name?: unknown; mimeType?: unknown} | null | undefined;
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)
    && value.projectId === input.projectId && value.name === input.name && value.mimeType === input.mimeType);
}
