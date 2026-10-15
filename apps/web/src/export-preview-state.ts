
type PreviewRange = { startFrame: number; endFrame: number };
type Context = { scope: string; projectId: string; timelineId: string; revision: number; exportSettings?: unknown; settingsVersion?: number; exportRange?: unknown; rangeVersion?: number };
type SavedTimeline = { clips?: { assetId: string }[]; [key: string]: unknown };
export type PreviewInput = { projectId: string; requestId: string; expectedRevision: number; purpose: 'export'; [key: string]: unknown };
export type PreviewRecord = { id: string; requestId: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; assetId: string | null; snapshot: unknown };
export type PreviewAttempt = { scope: string; timelineId: string; contextKey: string; input: PreviewInput; submitting: boolean; exportId: string | null; receipt: PreviewRecord | null };
export type PreviewResult = { phase: 'idle' | 'submitting' | 'unknown' | 'unavailable' | PreviewRecord['status']; record: PreviewRecord | null; stale: boolean; url: string | null };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export const EXPORT_PREVIEW_MAX_FRAMES = 300;
export function isExportPreviewRange(range: PreviewRange | null | undefined, durationFrames: number) {
  return Boolean(range && Number.isSafeInteger(durationFrames) && Number.isSafeInteger(range.startFrame) && Number.isSafeInteger(range.endFrame) &&
    range.startFrame >= 0 && range.endFrame > range.startFrame && range.endFrame <= durationFrames && range.endFrame - range.startFrame <= EXPORT_PREVIEW_MAX_FRAMES);
}
export function suggestedExportPreviewRange(durationFrames: number, playhead = 0, selectedRange?: PreviewRange | null) {
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 1) return null;
  const startFrame = selectedRange && Number.isSafeInteger(selectedRange.startFrame) ? selectedRange.startFrame : Number.isSafeInteger(playhead) ? playhead : 0;
  const start = Math.max(0, Math.min(startFrame, durationFrames - 1));
  return { startFrame: start, endFrame: Math.min(durationFrames, start + EXPORT_PREVIEW_MAX_FRAMES,
    selectedRange && Number.isSafeInteger(selectedRange.endFrame) && selectedRange.endFrame > start ? selectedRange.endFrame : durationFrames) };
}
// Keep the exact per-export controls and saved source identities, not global
// preferences or a mutable "latest export" selection. Reordering assets is inert.
export function exportPreviewContextKey(context: Context, timeline: SavedTimeline | null, assets: Record<string, unknown>[] = []) {
  const wanted = new Set(timeline?.clips?.map(clip => clip.assetId) || []);
  const sources = assets.filter(asset => typeof asset.id === 'string' && wanted.has(asset.id)).map(asset => [asset.id, asset.sha256, asset.sizeBytes, asset.mimeType, asset.duration, asset.width, asset.height, asset.hasAudio, asset.relativePath, asset.url, asset.provenance]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify([context.scope, context.projectId, context.timelineId, context.revision, context.exportSettings, context.settingsVersion, context.exportRange, context.rangeVersion, timeline, sources]);
}
export function exportPreviewResult(attempt: PreviewAttempt | null, exports: unknown[], { scope, contextKey, connected, heldExportIds = [], isRenderRecord }: { scope: string; contextKey: string; connected: boolean; heldExportIds?: string[]; isRenderRecord: (value: unknown, input: unknown) => boolean }): PreviewResult {
  if (!attempt || attempt.scope !== scope) return { phase: 'idle', record: null, stale: false, url: null };
  const matches = (exports || []).filter(row => object(row) && row.requestId === attempt.input.requestId);
  // A malformed or ambiguous observation can never confer playback authority.
  const row = matches.length === 1 && isRenderRecord(matches[0], { ...attempt.input, timelineId: attempt.timelineId, ...(attempt.exportId ? { exportId: attempt.exportId } : {}) }) ? matches[0] as PreviewRecord : null;
  const record = row || (matches.length === 0 && attempt.receipt && isRenderRecord(attempt.receipt, { ...attempt.input, timelineId: attempt.timelineId, ...(attempt.exportId ? { exportId: attempt.exportId } : {}) }) ? attempt.receipt : null);
  const stale = attempt.contextKey !== contextKey;
  if (matches.length && !row) return { phase: 'unavailable', record: null, stale, url: null };
  const held = record && heldExportIds.includes(record.id);
  return { phase: !connected || held ? 'unavailable' : record?.status || (attempt.submitting ? 'submitting' : 'unknown'), record, stale,
    url: connected && !held && !stale && record?.status === 'succeeded' ? `/media/${record.assetId}?preview=1&exportId=${record.id}` : null };
}
