/** Storage-format-scoped timeline record guards for the business layer.
 *
 * `isTimelineRecord` only accepts the format-5 clip sound flags (`muted`,
 * `soundOnly`) when the caller states the format being validated. Business code
 * that has a project database must resolve that format from the file itself
 * (format 5 stores native clip/cue rows; formats 3/4 store one legacy record),
 * so every format-agnostic retained/read path states the real format instead of
 * silently accepting format-5-only fields on format 3/4 records.
 */
import type {DatabaseSync} from 'node:sqlite';
import {isSequenceTimelineFormat, isTimelineRecord, isTimelineReplacementResponse,
  type TimelineRecordOptions} from '../../contracts/src/timeline-replacement.ts';
import {isTimelineMutationResponse, isTimelineRenderRecord} from '../../contracts/src/timeline-acknowledgement.ts';
import {timelineStorageFormat, timelineStorageSchema} from './project-file/timeline-storage.ts';

type PreparedDatabase = Pick<DatabaseSync, 'prepare'>;
const formatCache = new WeakMap<object, number>();

/** The project file format as a legacy timeline record format: 5 when the file
 * stores native format-5 rows (and the format-5-only clip flags are legal),
 * otherwise the released 3/4 record format. */
export function timelineRecordFormatOf(db: PreparedDatabase): number {
  const cached = formatCache.get(db as object);
  if (cached !== undefined) return cached;
  const database = db as unknown as DatabaseSync;
  const schema = timelineStorageSchema(database);
  const stored = Number(timelineStorageFormat(database, schema));
  const format = isSequenceTimelineFormat(stored) ? stored : 4;
  formatCache.set(db as object, format);
  return format;
}

export function timelineFormatOptions(db: PreparedDatabase, options: TimelineRecordOptions = {}): TimelineRecordOptions {
  return {...options, format: timelineRecordFormatOf(db)};
}

/** Format-scoped structural guard; use only where the record belongs to the
 * same project file the database was opened from. */
export function isTimelineRecordFor(db: PreparedDatabase, value: unknown, options: TimelineRecordOptions = {}): boolean {
  return isTimelineRecord(value, timelineFormatOptions(db, options));
}

export function isTimelineReplacementResponseFor(db: PreparedDatabase, value: unknown, input: unknown): boolean {
  return isTimelineReplacementResponse(value, input, {format: timelineRecordFormatOf(db)});
}

export function isTimelineMutationResponseFor(db: PreparedDatabase, operation: unknown, input: unknown,
  value: unknown): boolean {
  return isTimelineMutationResponse(operation, input, value, {format: timelineRecordFormatOf(db)});
}

export function isTimelineRenderRecordFor(db: PreparedDatabase, value: unknown, input: unknown): boolean {
  return isTimelineRenderRecord(value, input, {format: timelineRecordFormatOf(db)});
}
