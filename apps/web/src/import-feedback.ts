import { message, renderMessage } from '../../../packages/i18n/src/index.ts';
// Bound untrusted filenames and never interpolate provider diagnostics into a
// primary notice. Descriptors retain request-time facts across language changes.
function displayText(value, limit = 64) {
  const original = String(value || '');
  const characters = Array.from(original.slice(0, limit * 4).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' '));
  return characters.slice(0, limit).join('') + (original.length > limit * 4 || characters.length > limit ? '…' : '');
}
function fileNames(files) { return files.slice(0, 3).map(file => `「${displayText(file.name)}」`).join('、') + (files.length > 3 ? ' …' : ''); }
export function importBusyFeedback(files) {
  return message('assets.importBusy', { count: files.length, files: fileNames(files) });
}
export function importFeedback(files, done, stopped = null) {
  const confirmed = { count: done, files: fileNames(files.slice(0, done)) };
  if (!stopped) return message('assets.importComplete', confirmed);
  const descriptor = message(stopped.kind === 'local' ? 'assets.importLocalFailed' : stopped.kind === 'rejected' ? 'assets.importRejected' : 'assets.importUnknown', {
    ...confirmed, current: fileNames(files.slice(done, done + 1)), remaining: files.slice(done + 1).length, unattempted: fileNames(files.slice(done + 1)), omitted: Math.max(0, done - 3), unattemptedOmitted: Math.max(0, files.length - done - 4),
  });
  return stopped.reason && typeof stopped.reason === 'object' ? Object.freeze({ ...descriptor, detail: stopped.reason }) : descriptor;
}
export function renderImportFeedback(locale, value) { return renderMessage(locale, value) + (value?.detail ? ` ${renderMessage(locale, value.detail)}` : ''); }
// asset.import already returns this asset identity. This is a narrow check of
// its existing response, not a new receipt, replay key or recovery protocol.
export function importAcknowledged(asset, input) {
  return Boolean(asset && typeof asset === 'object' && !Array.isArray(asset)
    && typeof asset.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(asset.id)
    && asset.projectId === input.projectId && asset.name === input.name && asset.mimeType === input.mimeType);
}
