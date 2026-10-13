import {z} from 'zod';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
const duration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 18000;
function invalid(): never {
  throw Object.assign(new Error('Invalid frozen timeline export range'), {code: 'INVALID_TIMELINE_SNAPSHOT'});
}

// The clock belongs to the saved composition. This optional half-open interval
// never edits its timeline, source ranges, fades, cues, or encoding profile.
export const timelineExportRangeSchema = z.object({
  startFrame: z.number().int().min(0).max(17999).describe('Included start frame on the saved composition clock, fixed at 30fps.'),
  endFrame: z.number().int().min(1).max(18000).describe('Excluded end frame on the same 30fps composition clock. Must exceed startFrame; fresh export acceptance requires it not exceed the current saved timeline duration.'),
}).strict().refine(value => value.endFrame > value.startFrame, {
  message: 'Export range must contain at least one 30fps frame', path: ['endFrame'],
}).describe('Export-only half-open [startFrame,endFrame) range on the saved 30fps composition. At least one frame; bounded by the saved timeline. Omission preserves full export.');
export type TimelineExportRange = z.infer<typeof timelineExportRangeSchema>;
export type TimelineExportRangeInput = {exportRange?: TimelineExportRange};

export function isTimelineExportRangeInput(value: unknown, purpose?: unknown): value is TimelineExportRangeInput & Record<string, unknown> {
  return object(value) && (!own(value, 'exportRange') ||
    (purpose === undefined || purpose === 'export') && timelineExportRangeSchema.safeParse(value.exportRange).success);
}

// Syntax only: historical replay and stale-revision reporting must precede any
// comparison with today's duration. No omitted field or default is inserted.
export function timelineExportRangeFields(value: unknown): TimelineExportRangeInput {
  if (!isTimelineExportRangeInput(value)) invalid();
  return own(value, 'exportRange') ? {exportRange: timelineExportRangeSchema.parse(value.exportRange)} : {};
}

export function isTimelineExportRangeWithinDuration(value: unknown, durationFrames: unknown): boolean {
  if (!isTimelineExportRangeInput(value)) return false;
  return !own(value, 'exportRange') || duration(durationFrames) && value.exportRange!.endFrame <= durationFrames;
}

export function isTimelineExportRangeSnapshot(
  snapshot: unknown,
  options: {purpose?: unknown; input?: unknown} = {},
): boolean {
  if (!isTimelineExportRangeInput(snapshot)) return false;
  if (own(snapshot, 'exportRange')) {
    if (own(options, 'purpose') && options.purpose !== 'export') return false;
    if (!object(snapshot) || !object(snapshot.timeline) || snapshot.timeline.fps !== 30 ||
        !isTimelineExportRangeWithinDuration(snapshot, snapshot.timeline.durationFrames)) return false;
  }
  if (!own(options, 'input')) return true;
  if (!isTimelineExportRangeInput(options.input)) return false;
  if (own(snapshot, 'exportRange') !== own(options.input, 'exportRange')) return false;
  return !own(snapshot, 'exportRange') || snapshot.exportRange!.startFrame === options.input.exportRange!.startFrame &&
    snapshot.exportRange!.endFrame === options.input.exportRange!.endFrame;
}

// Only use this for an accepted nonempty frozen composition. It does not make
// an unchecked or malformed snapshot valid, and it never modifies that data.
export function timelineExportOutputFrames(snapshot: unknown): number {
  if (!object(snapshot) || !object(snapshot.timeline) || snapshot.timeline.fps !== 30 ||
      !duration(snapshot.timeline.durationFrames) || snapshot.timeline.durationFrames < 1 ||
      !isTimelineExportRangeSnapshot(snapshot)) invalid();
  const range = timelineExportRangeFields(snapshot).exportRange;
  return range === undefined ? snapshot.timeline.durationFrames : range.endFrame - range.startFrame;
}

/** Old omitted-range proofs keep their historical behavior. Any newly ranged
 * intent must pass the complete existing export-input guard before any proof
 * code, including a generic revision conflict, can release its request key.
 * Newly ranged proofs also require explicit operation/project/request identity. */
export function isTimelineExportRangeProofInput(
  input: unknown,
  options: {operation?: unknown; error: unknown; isRenderInput: (value: unknown) => boolean},
): boolean {
  if (!object(input) || !own(input, 'exportRange')) return true;
  if (options.operation !== 'timeline.render' || input.purpose !== 'export' ||
      !isTimelineExportRangeInput(input, input.purpose) || !object(options.error) || !object(options.error.details) ||
      options.error.details.operation !== options.operation || options.error.details.projectId !== input.projectId ||
      options.error.details.requestId !== input.requestId) return false;
  try { return options.isRenderInput(input) === true; } catch { return false; }
}

/** Validate a fresh business rejection's identity, never a generic HTTP error.
 * The caller supplies the existing complete render-input guard as an adapter;
 * the range module does not duplicate the encoding/name schemas or normalize
 * the original intent. A failed guard cannot release the retained request key. */
export function hasTimelineExportRangeBoundsProof(
  error: unknown,
  input: unknown,
  options: {operation?: unknown; isRenderInput: (value: unknown) => boolean},
): boolean {
  if (options.operation !== 'timeline.render' || !object(error) || error.code !== 'EXPORT_RANGE_BOUNDS' ||
      !object(input) || input.purpose !== 'export' || !own(input, 'exportRange') ||
      !isTimelineExportRangeInput(input, input.purpose) || !object(error.details)) return false;
  if (!isTimelineExportRangeProofInput(input, {...options, error})) return false;
  const status = error.status;
  return (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 499 &&
    status !== 401 && status !== 403 || status === undefined && error.definitive === true) &&
    error.details.mutationOutcome === 'not_applied' && error.details.operation === options.operation &&
    error.details.projectId === input.projectId && error.details.requestId === input.requestId;
}
