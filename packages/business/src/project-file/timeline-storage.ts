import type {DatabaseSync} from 'node:sqlite';
import {TIMELINE_RESPONSE_BYTES} from '../../../contracts/src/timeline-replacement.ts';
import {AppError} from '../../../contracts/src/app-error.ts';
import type {ContentStamp} from '../../../contracts/src/project-file.ts';
import {readProjectContentStamp} from './content-stamp.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from './schema/databases.ts';
import {readFormat5TimelineRecord, readFormat5TimelineState} from './format5-timeline.ts';

type Schema = 'main' | 'project';
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (): never => {throw new AppError('PROJECT_INVALID', '项目内容与格式不符。', 422, {database: 'project', reason: 'metadata'});};

/** Databases that hold the project file: kernel connections attach it as
 * `project`, read-only inspection and copied-project readers open it as `main`. */
export function timelineStorageSchema(db: DatabaseSync): Schema {
  const attached = new Set(db.prepare('PRAGMA database_list').all().map(row => String(row.name)));
  return attached.has('project') ? 'project' : 'main';
}
export function timelineStorageFormat(db: DatabaseSync, schema: Schema): number {
  return Number(db.prepare(`PRAGMA ${schema}.user_version`).get()?.user_version ?? 0);
}

export interface TimelineStorageSnapshot {
  /** True when the project file is format 5 (native clip/cue rows). */
  readonly format5: boolean;
  readonly id: string;
  readonly projectId: string;
  /** Canonical serialization used for change detection. For format 5 it is the
   * assembled read projection, so equal bytes mean an unchanged timeline. */
  readonly raw: string;
  /** The assembled `TimelineRecord` (legacy: the stored record). */
  readonly timeline: unknown;
  /** Format-5 project content stamp; null for released 3/4 formats. */
  readonly stamp: ContentStamp | null;
}
export interface TimelineHeaderSnapshot {
  readonly format5: boolean;
  readonly id: string;
  readonly projectId: string;
  /** Format 5: the stored header object. Legacy: the stored record. */
  readonly header: unknown;
  /** Format 5: canonical header JSON. Legacy: the stored data bytes. */
  readonly raw: string;
  readonly stamp: ContentStamp | null;
}

export interface TimelineReadOptions {readonly schema?: Schema; readonly maxBytes?: number;}

function legacyRow(db: DatabaseSync, schema: Schema, projectId: string, maxBytes: number): Row | null {
  const rows = db.prepare(`SELECT id,projectId,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND ?
    THEN data END AS data FROM ${schema}.timelines WHERE projectId=? LIMIT 2`).all(maxBytes, projectId) as Row[];
  if (rows.length > 1) return invalid();
  return rows[0] ?? null;
}
function parseLegacy(row: Row): unknown {
  if (typeof row.data !== 'string') return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

/** Full timeline read shared by every direct `timelines.data` caller. Format 3
 * and 4 return the stored record bytes; format 5 assembles the native rows. */
export function readTimelineStorage(db: DatabaseSync, projectId: string, options: TimelineReadOptions = {}): TimelineStorageSnapshot | null {
  const schema = options.schema ?? timelineStorageSchema(db);
  if (timelineStorageFormat(db, schema) === FORMAT5_PROJECT_SCHEMA_VERSION) {
    const record = readFormat5TimelineRecord(db, schema);
    if (!record || record.projectId !== projectId) return null;
    return {format5: true, id: record.id, projectId, raw: JSON.stringify(record), timeline: record, stamp: readProjectContentStamp(db, schema)};
  }
  const row = legacyRow(db, schema, projectId, options.maxBytes ?? TIMELINE_RESPONSE_BYTES);
  if (!row || typeof row.id !== 'string' || row.projectId !== projectId) return null;
  const timeline = parseLegacy(row);
  return {format5: false, id: row.id, projectId, raw: typeof row.data === 'string' ? row.data : '', timeline, stamp: null};
}

/** Header-only read for callers that need revision/geometry/updatedAt but never
 * the clip array. Format 5 skips the native rows entirely. */
export function readTimelineHeaderStorage(db: DatabaseSync, projectId: string, options: TimelineReadOptions = {}): TimelineHeaderSnapshot | null {
  const schema = options.schema ?? timelineStorageSchema(db);
  if (timelineStorageFormat(db, schema) === FORMAT5_PROJECT_SCHEMA_VERSION) {
    const state = readFormat5TimelineState(db, schema);
    if (!state.header || state.header.projectId !== projectId) return null;
    let header: unknown;
    try { header = JSON.parse(state.header.raw); } catch { return invalid(); }
    if (!object(header)) return invalid();
    return {format5: true, id: state.header.id, projectId, header, raw: state.header.raw, stamp: readProjectContentStamp(db, schema)};
  }
  const row = legacyRow(db, schema, projectId, options.maxBytes ?? TIMELINE_RESPONSE_BYTES);
  if (!row || typeof row.id !== 'string' || row.projectId !== projectId) return null;
  const timeline = parseLegacy(row);
  return {format5: false, id: row.id, projectId, header: timeline, raw: typeof row.data === 'string' ? row.data : '', stamp: null};
}

/** Format-5 change evidence for callers that used to compare raw `data` bytes. */
export function timelineStorageChanged(before: {readonly raw: string; readonly stamp: ContentStamp | null},
  after: {readonly raw: string; readonly stamp: ContentStamp | null}): boolean {
  if (before.stamp || after.stamp) {
    if (!before.stamp || !after.stamp) return true;
    return before.stamp.contentSequence !== after.stamp.contentSequence || before.stamp.contentToken !== after.stamp.contentToken;
  }
  return before.raw !== after.raw;
}
