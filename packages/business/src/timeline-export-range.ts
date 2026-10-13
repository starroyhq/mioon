import {isTimelineExportRangeInput, isTimelineExportRangeWithinDuration} from '@mioon/contracts/timeline-export-range';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Presence, not truthiness: malformed or deleted optional fields must never
 * opt a selected-range request back into legacy lazy initialization. */
export function hasSelectedTimelineExportRange(input: unknown): boolean {
  return object(input) && Object.hasOwn(input, 'exportRange');
}

/** Only call after the existing ownership, exact-replay and revision boundary.
 * This does not itself authorize any write or normalize the original input. */
export function timelineExportRangeBoundsIssue(input: unknown, durationFrames: unknown):
  Readonly<{code: 'EXPORT_RANGE_BOUNDS'; message: string; status: 400}> | null {
  if (isTimelineExportRangeInput(input) && isTimelineExportRangeWithinDuration(input, durationFrames)) return null;
  return {code: 'EXPORT_RANGE_BOUNDS', message: '导出选区必须位于已保存时间线内，且至少包含 1 帧；结束帧不包含在输出中', status: 400};
}

/** Selected range is immutable output identity even without an opt-in encoding
 * profile. Join the existing prepared-source and publication guards, without
 * adding a capability probe to the legacy encoder path. */
export function requiresPreparedTimelineExportIdentity(record: unknown): boolean {
  return object(record) && object(record.snapshot) &&
    (Object.hasOwn(record.snapshot, 'delivery') || Object.hasOwn(record.snapshot, 'exportRange'));
}

export function timelineExportRangeEffectError(): Error & {code: 'INVALID_TIMELINE_SNAPSHOT'} {
  return Object.assign(new Error('The selected export or its owned staging changed.'), {code: 'INVALID_TIMELINE_SNAPSHOT' as const});
}

