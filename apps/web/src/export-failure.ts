/** Plain-language reason for a terminal export failure. Unknown codes stay
 * bounded and never expose server paths, probe output or raw error codes. */
export type ExportFailureKey =
  | 'redesign.export.failure.changed'
  | 'redesign.export.failure.blocked'
  | 'redesign.export.failure.cancelled'
  | 'redesign.export.failure.unavailable'
  | 'redesign.export.failure.generic';

export function exportFailureKey(error: unknown): ExportFailureKey {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (code === 'EXPORT_CANCELLED') return 'redesign.export.failure.cancelled';
  if (code === 'REVISION_CONFLICT' || code === 'PREFLIGHT_STALE' || code === 'CONFLICT') return 'redesign.export.failure.changed';
  if (code === 'EXPORT_BLOCKED' || code === 'PLACEHOLDER_CLIP' || code === 'EXPORT_RANGE_BOUNDS') return 'redesign.export.failure.blocked';
  if (code.includes('UNAVAILABLE') || code.includes('TOOL') || code.includes('CAPABILITY')) return 'redesign.export.failure.unavailable';
  return 'redesign.export.failure.generic';
}
