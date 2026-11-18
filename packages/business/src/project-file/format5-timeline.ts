import type {DatabaseSync, StatementSync} from 'node:sqlite';
import {AppError} from '../../../contracts/src/app-error.ts';
import {
  FORMAT5_LIMITS, getFormat5ClipIssue, getFormat5CueIssue, getFormat5TimelineHeaderIssue,
  getFormat5TimelineIssue, format5TimelineHeader,
} from '../../../contracts/src/project-format5.ts';
import type {Format5Clip, Format5Cue, Format5Issue, Format5Timeline, Format5TimelineHeader} from '../../../contracts/src/project-format5.ts';

type ProjectSchema = 'main' | 'project';
type Row = Record<string, unknown>;
export type Format5TimelineEntityKind = 'clip' | 'cue';
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
export const invalidFormat5Timeline = (): never => {throw new AppError('PROJECT_INVALID', '项目内容与格式 5 不符。', 422, {database: 'project', reason: 'metadata'});};
const entityError = (problem: Format5Issue): AppError => new AppError(problem.code, problem.message, 422, {database: 'project', reason: 'metadata'});
const ENTITY_TABLES: Readonly<Record<Format5TimelineEntityKind, string>> = {clip: 'timeline_clips', cue: 'timeline_cues'};

/** Prepared statements are schema-stable per connection; a benchmark or sync
 * transaction issues the same handful of statements on every sample. */
const statementCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function prepared(db: DatabaseSync, sql: string): StatementSync {
  let cache = statementCache.get(db);
  if (!cache) {cache = new Map(); statementCache.set(db, cache);}
  let statement = cache.get(sql);
  if (!statement) {statement = db.prepare(sql); cache.set(sql, statement);}
  return statement;
}

type EntityColumnValue = string | number | null;
/** One stored entity row: native identity plus exact persisted JSON text. The
 * raw text is the byte-semantics source for revision and dirty checks; the
 * structural columns are the projection queried by reads and the fence. */
export interface Format5TimelineEntityRow {
  readonly timelineId: string;
  readonly id: string;
  readonly projectId: string;
  readonly raw: string;
  readonly columns: Readonly<Record<string, EntityColumnValue>>;
}
const CLIP_COLUMNS = ['trackId', 'startFrame', 'durationFrames', 'sourceInFrame', 'sourceState', 'anchorPresent',
  'anchorClipId', 'anchorOffset', 'sourceKind', 'sourceNodeId', 'segmentGroupId', 'versionMode',
  'versionId', 'assetId', 'shotId', 'jobId'] as const;
const CUE_COLUMNS = ['startFrame', 'durationFrames', 'anchorClipId', 'anchorOffset', 'dialogueShotId', 'dialogueLineId'] as const;
const COLUMNS_OF: Readonly<Record<Format5TimelineEntityKind, readonly string[]>> = {clip: CLIP_COLUMNS, cue: CUE_COLUMNS};
function rowColumns(kind: Format5TimelineEntityKind, row: Record<string, unknown>): Readonly<Record<string, EntityColumnValue>> {
  const columns: Record<string, EntityColumnValue> = {};
  for (const column of COLUMNS_OF[kind]) {
    const value = row[column];
    columns[column] = typeof value === 'string' || typeof value === 'number' ? value : null;
  }
  return columns;
}
export interface Format5TimelineState {
  readonly header?: {readonly id: string; readonly projectId: string; readonly raw: string};
  readonly clips: readonly Format5TimelineEntityRow[];
  readonly cues: readonly Format5TimelineEntityRow[];
}

function readTimelineRows(db: DatabaseSync, schema: ProjectSchema, kind: Format5TimelineEntityKind): Format5TimelineEntityRow[] {
  const rows = prepared(db, `SELECT timelineId,id,projectId,${COLUMNS_OF[kind].join(',')},CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data
    FROM ${schema}.${ENTITY_TABLES[kind]} ORDER BY id`).all(FORMAT5_LIMITS.timelineBytes);
  return rows.map(row => {
    if (typeof row.data !== 'string' || typeof row.id !== 'string' || typeof row.projectId !== 'string' || typeof row.timelineId !== 'string') return invalidFormat5Timeline();
    return {timelineId: row.timelineId, id: row.id, projectId: row.projectId, raw: row.data, columns: rowColumns(kind, row)};
  });
}

/** Read the complete stored timeline state without assembling a projection:
 * exactly one optional header plus native clip and cue rows. */
export function readFormat5TimelineState(db: DatabaseSync, schema: ProjectSchema): Format5TimelineState {
  const headers = prepared(db, `SELECT id,projectId,CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data
    FROM ${schema}.timelines ORDER BY id`).all(FORMAT5_LIMITS.timelineBytes);
  if (headers.length > 1) return invalidFormat5Timeline();
  const header = headers[0];
  if (header && (typeof header.data !== 'string' || typeof header.id !== 'string' || typeof header.projectId !== 'string')) return invalidFormat5Timeline();
  const next = header ? {id: header.id as string, projectId: header.projectId as string, raw: header.data as string} : undefined;
  const clips = readTimelineRows(db, schema, 'clip'), cues = readTimelineRows(db, schema, 'cue');
  if (clips.length || cues.length) {
    if (!next) return invalidFormat5Timeline();
    for (const row of [...clips, ...cues]) if (row.timelineId !== next.id || row.projectId !== next.projectId) return invalidFormat5Timeline();
  }
  return {header: next, clips, cues};
}

/** Read the header plus only the requested entity rows. A single-clip edit
 * must not scan the 1,500-row table; batch/reorder passes every affected id. */
export function readFormat5TimelineStateForIds(db: DatabaseSync, schema: ProjectSchema,
  selection: {readonly clipIds?: readonly string[]; readonly cueIds?: readonly string[]} = {}): Format5TimelineState {
  const headers = prepared(db, `SELECT id,projectId,CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data
    FROM ${schema}.timelines ORDER BY id`).all(FORMAT5_LIMITS.timelineBytes);
  if (headers.length > 1) return invalidFormat5Timeline();
  const header = headers[0];
  if (header && (typeof header.data !== 'string' || typeof header.id !== 'string' || typeof header.projectId !== 'string')) return invalidFormat5Timeline();
  const read = (kind: Format5TimelineEntityKind, requested?: readonly string[]): Format5TimelineEntityRow[] => {
    if (!requested) return readTimelineRows(db, schema, kind);
    if (!requested.length) return [];
    const rows = prepared(db, `SELECT timelineId,id,projectId,${COLUMNS_OF[kind].join(',')},CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data
      FROM ${schema}.${ENTITY_TABLES[kind]} WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(FORMAT5_LIMITS.timelineBytes, JSON.stringify([...requested]));
    return rows.map(row => {
      if (typeof row.data !== 'string' || typeof row.id !== 'string' || typeof row.projectId !== 'string' || typeof row.timelineId !== 'string') return invalidFormat5Timeline();
      return {timelineId: row.timelineId, id: row.id, projectId: row.projectId, raw: row.data, columns: rowColumns(kind, row)};
    });
  };
  return {header: header ? {id: header.id as string, projectId: header.projectId as string, raw: header.data as string} : undefined,
    clips: read('clip', selection.clipIds), cues: read('cue', selection.cueIds)};
}

function parseRaw(raw: string): Row {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return invalidFormat5Timeline(); }
  if (!object(value)) return invalidFormat5Timeline();
  return value;
}

/** The assembled read projection. Rows are ordered canonically by track order,
 * frame and ID so enumeration order is never part of the stored bytes. */
export function assembleFormat5Timeline(state: Format5TimelineState): Format5Timeline | null {
  if (!state.header) return null;
  const header = parseRaw(state.header.raw);
  if (header.id !== state.header.id || header.projectId !== state.header.projectId) return invalidFormat5Timeline();
  const tracks = Array.isArray(header.tracks) ? header.tracks.filter(object) : [];
  const trackOrder = new Map<string, number>(), trackIds = new Map<string, number>();
  tracks.forEach((track, index) => {
    trackOrder.set(String(track.id), typeof track.orderIndex === 'number' ? track.orderIndex : index);
    trackIds.set(String(track.id), index);
  });
  const compare = (a: Row, b: Row): number => {
    const left = trackOrder.get(String(a.trackId)) ?? Number.MAX_SAFE_INTEGER, right = trackOrder.get(String(b.trackId)) ?? Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
    const leftTrack = String(a.trackId), rightTrack = String(b.trackId);
    if (leftTrack !== rightTrack) return leftTrack < rightTrack ? -1 : 1;
    const leftFrame = typeof a.startFrame === 'number' ? a.startFrame : 0, rightFrame = typeof b.startFrame === 'number' ? b.startFrame : 0;
    if (leftFrame !== rightFrame) return leftFrame - rightFrame;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  };
  const clips = state.clips.map(row => parseRaw(row.raw)).sort(compare) as unknown as Format5Clip[];
  const cues = state.cues.map(row => parseRaw(row.raw))
    .sort((a, b) => Number(a.startFrame) - Number(b.startFrame) || String(a.id).localeCompare(String(b.id))) as unknown as Format5Cue[];
  const {id, projectId, revision, width, height, fps, durationFrames, createdAt, updatedAt, mainTrack, subtitles} = header;
  return {
    id, projectId, revision, width, height, fps, durationFrames, createdAt, updatedAt, mainTrack,
    tracks: tracks as Format5Timeline['tracks'], clips, ...(object(subtitles) ? {subtitles: {...subtitles, cues}} : {}),
  } as Format5Timeline;
}

export function readFormat5TimelineRecord(db: DatabaseSync, schema: ProjectSchema): Format5Timeline | null {
  return assembleFormat5Timeline(readFormat5TimelineState(db, schema));
}

function storedBytes(state: Format5TimelineState): number {
  const base = state.header ? Buffer.byteLength(state.header.raw) : 0;
  return state.clips.reduce((sum, row) => sum + Buffer.byteLength(row.raw), base)
    + state.cues.reduce((sum, row) => sum + Buffer.byteLength(row.raw), 0);
}

/** Full structural validation for opening, conversion terminal checks and
 * tests. Row writes additionally pass through the commit fence. */
export function assertFormat5TimelineRows(db: DatabaseSync, schema: ProjectSchema): Format5Timeline | null {
  const state = readFormat5TimelineState(db, schema);
  if (!state.header) {
    if (state.clips.length || state.cues.length) return invalidFormat5Timeline();
    return null;
  }
  const header = parseRaw(state.header.raw);
  const headerProblem = getFormat5TimelineHeaderIssue(header, {projectId: state.header.projectId});
  if (headerProblem) throw entityError(headerProblem);
  const timeline = assembleFormat5Timeline(state);
  if (!timeline) return invalidFormat5Timeline();
  const problem = getFormat5TimelineIssue(timeline, {projectId: state.header.projectId});
  if (problem) throw entityError(problem);
  if (storedBytes(state) > FORMAT5_LIMITS.timelineBytes) return invalidFormat5Timeline();
  return timeline;
}

/** Validate one incoming entity against the header context and the whole-record
 * contract, returning the exact persisted raw text. */
function clipRaw(value: unknown, header: Format5TimelineHeader): string {
  const row = value as Row;
  const tracks = new Map(header.tracks.map(track => [track.id, track.kind]));
  if (!object(row) || !uuid(row.id) || !uuid(row.trackId) || !tracks.has(String(row.trackId)))
    throw entityError({code: 'FORMAT5_CLIP_INVALID', message: 'Invalid format-5 clip'});
  const problem = getFormat5ClipIssue(value, {
    width: header.width, height: header.height, fps: header.fps,
    trackKind: tracks.get(String(row.trackId)) as 'video' | 'audio' | undefined,
    main: row.trackId === header.mainTrack.trackId,
  });
  if (problem) throw entityError(problem);
  return JSON.stringify(row);
}
function cueRaw(value: unknown, header: Format5TimelineHeader): string {
  if (!object(value) || !uuid(value.id)) throw entityError({code: 'FORMAT5_SUBTITLES_INVALID', message: 'Invalid format-5 subtitle cue'});
  const problem = getFormat5CueIssue(value, {durationFrames: header.durationFrames});
  if (problem) throw entityError(problem);
  return JSON.stringify(value);
}
function headerOf(state: Format5TimelineState): Format5TimelineHeader {
  if (!state.header) return invalidFormat5Timeline();
  const header = parseRaw(state.header.raw);
  const problem = getFormat5TimelineHeaderIssue(header, {projectId: state.header.projectId});
  if (problem) throw entityError(problem);
  return header as unknown as Format5TimelineHeader;
}


export interface Format5TimelineEntityWriter {readonly db: DatabaseSync; readonly projectId: string; tx<T>(callback: () => T): T;}

/** Storage projection of one validated entity. Exactly the fields the commit
 * fence and read path query are materialized; `data` keeps the original bytes. */
export function format5TimelineEntityColumns(kind: Format5TimelineEntityKind, value: Row): Record<string, EntityColumnValue> {
  if (kind === 'clip') {
    const anchor = object(value.anchor) ? value.anchor : undefined;
    const source = object(value.sequenceSource) ? value.sequenceSource : undefined;
    return {
      trackId: value.trackId as string, startFrame: value.startFrame as number, durationFrames: value.durationFrames as number,
      sourceInFrame: value.sourceInFrame as number, sourceState: value.sourceState as string,
      anchorPresent: Object.hasOwn(value, 'anchor') ? 1 : 0,
      anchorClipId: anchor ? anchor.clipId as string : null, anchorOffset: anchor ? anchor.offsetFrames as number : null,
      sourceKind: source ? source.kind as string : null, sourceNodeId: source ? source.nodeId as string : null,
      segmentGroupId: source ? source.segmentGroupId as string : null,
      versionMode: source && source.kind === 'shot' ? source.versionMode as string : null,
      versionId: typeof value.versionId === 'string' ? value.versionId : null,
      assetId: typeof value.assetId === 'string' ? value.assetId : null,
      shotId: typeof value.shotId === 'string' ? value.shotId : null,
      jobId: typeof value.jobId === 'string' ? value.jobId : null,
    };
  }
  const anchor = object(value.anchor) ? value.anchor : undefined, dialogue = object(value.dialogueRef) ? value.dialogueRef : undefined;
  return {
    startFrame: value.startFrame as number, durationFrames: value.durationFrames as number,
    anchorClipId: anchor ? anchor.clipId as string : null, anchorOffset: anchor ? anchor.offsetFrames as number : null,
    dialogueShotId: dialogue ? dialogue.shotId as string : null, dialogueLineId: dialogue ? dialogue.lineId as string : null,
  };
}

export interface Format5TimelineEntityChange {
  readonly kind: Format5TimelineEntityKind;
  readonly id: string;
  readonly raw: string;
  readonly columns: Readonly<Record<string, EntityColumnValue>>;
  /** Columns whose stored value differs from the current row; data always
   * changes when a write exists, so an unchanged structural column is skipped. */
  readonly setColumns: readonly string[];
}
export interface Format5TimelineEntityUpdate {
  readonly timelineId: string;
  readonly projectId: string;
  readonly clipWrites: readonly Format5TimelineEntityChange[];
  readonly cueWrites: readonly Format5TimelineEntityChange[];
  readonly clipDeletes: readonly string[];
  readonly cueDeletes: readonly string[];
}
export interface Format5TimelineEntityPatch {
  readonly clips?: readonly Format5Clip[];
  readonly cues?: readonly Format5Cue[];
  readonly removedClipIds?: readonly string[];
  readonly removedCueIds?: readonly string[];
}
export interface Format5TimelineEntityUpdatePlan extends Format5TimelineEntityUpdate {readonly changed: boolean;}

function clipEntity(value: unknown, header: Format5TimelineHeader): Omit<Format5TimelineEntityChange, 'setColumns'> {
  const row = value as Row;
  const tracks = new Map(header.tracks.map(track => [track.id, track.kind]));
  if (!object(row) || !uuid(row.id) || !uuid(row.trackId) || !tracks.has(String(row.trackId)))
    throw entityError({code: 'FORMAT5_CLIP_INVALID', message: 'Invalid format-5 clip'});
  const problem = getFormat5ClipIssue(value, {
    width: header.width, height: header.height, fps: header.fps,
    trackKind: tracks.get(String(row.trackId)) as 'video' | 'audio' | undefined,
    main: row.trackId === header.mainTrack.trackId,
  });
  if (problem) throw entityError(problem);
  return {kind: 'clip', id: row.id as string, raw: JSON.stringify(row), columns: format5TimelineEntityColumns('clip', row)};
}
function cueEntity(value: unknown, header: Format5TimelineHeader): Omit<Format5TimelineEntityChange, 'setColumns'> {
  if (!object(value) || !uuid(value.id)) throw entityError({code: 'FORMAT5_SUBTITLES_INVALID', message: 'Invalid format-5 subtitle cue'});
  const problem = getFormat5CueIssue(value, {durationFrames: header.durationFrames});
  if (problem) throw entityError(problem);
  return {kind: 'cue', id: value.id as string, raw: JSON.stringify(value), columns: format5TimelineEntityColumns('cue', value)};
}
function changedColumns(kind: Format5TimelineEntityKind, columns: Readonly<Record<string, EntityColumnValue>>,
  previous: Readonly<Record<string, EntityColumnValue>> | undefined): readonly string[] {
  if (!previous) return COLUMNS_OF[kind];
  return COLUMNS_OF[kind].filter(column => columns[column] !== previous[column]);
}
function withColumns(entity: Omit<Format5TimelineEntityChange, 'setColumns'>, previous?: Format5TimelineEntityRow): Format5TimelineEntityChange {
  return {...entity, setColumns: changedColumns(entity.kind, entity.columns, previous?.columns)};
}

/** Validate and diff the deltas a caller wants to persist. Reading is the
 * caller's step so a sync service can time read and validate separately. */
export function planFormat5TimelineEntityUpdate(state: Format5TimelineState, patch: Format5TimelineEntityPatch): Format5TimelineEntityUpdatePlan {
  const header = headerOf(state);
  const clipOld = new Map(state.clips.map(row => [row.id, row])), cueOld = new Map(state.cues.map(row => [row.id, row]));
  const seen = new Set<string>(), clipWrites: Format5TimelineEntityChange[] = [], cueWrites: Format5TimelineEntityChange[] = [];
  for (const clip of patch.clips ?? []) {
    const entity = withColumns(clipEntity(clip, header), clipOld.get(clip.id));
    if (seen.has(entity.id)) throw entityError({code: 'FORMAT5_CLIP_INVALID', message: 'Duplicate clip identity'});
    seen.add(entity.id);
    if (clipOld.get(entity.id)?.raw !== entity.raw) clipWrites.push(entity);
  }
  for (const cue of patch.cues ?? []) {
    const entity = withColumns(cueEntity(cue, header), cueOld.get(cue.id));
    if (seen.has(entity.id)) throw entityError({code: 'FORMAT5_SUBTITLES_INVALID', message: 'Duplicate cue identity'});
    seen.add(entity.id);
    if (cueOld.get(entity.id)?.raw !== entity.raw) cueWrites.push(entity);
  }
  return {
    timelineId: state.header!.id, projectId: state.header!.projectId, clipWrites, cueWrites,
    clipDeletes: [...new Set(patch.removedClipIds ?? [])].filter(id => clipOld.has(id)),
    cueDeletes: [...new Set(patch.removedCueIds ?? [])].filter(id => cueOld.has(id)),
    changed: clipWrites.length + cueWrites.length > 0,
  };
}

function entityValues(change: Format5TimelineEntityChange, columns: readonly string[]): EntityColumnValue[] {
  return columns.map(column => change.columns[column] ?? null);
}
function insertEntity(db: DatabaseSync, schema: ProjectSchema, kind: Format5TimelineEntityKind, update: Format5TimelineEntityUpdate, change: Format5TimelineEntityChange): boolean {
  const columns = COLUMNS_OF[kind];
  const result = prepared(db, `INSERT INTO ${schema}.${ENTITY_TABLES[kind]}(timelineId,id,projectId,${columns.join(',')},data)
    VALUES(?,?,?,${columns.map(() => '?').join(',')},?) ON CONFLICT(id) DO NOTHING`)
    .run(update.timelineId, change.id, update.projectId, ...entityValues(change, columns), change.raw);
  return Number(result.changes) === 1;
}
function updateEntity(db: DatabaseSync, schema: ProjectSchema, kind: Format5TimelineEntityKind, change: Format5TimelineEntityChange): boolean {
  const set = change.setColumns.length ? `,${change.setColumns.map(column => `${column}=?`).join(',')}` : '';
  const result = prepared(db, `UPDATE ${schema}.${ENTITY_TABLES[kind]} SET data=?${set} WHERE id=? AND data IS NOT ?`)
    .run(change.raw, ...entityValues(change, change.setColumns), change.id, change.raw);
  return Number(result.changes) === 1;
}
function deleteEntity(db: DatabaseSync, schema: ProjectSchema, kind: Format5TimelineEntityKind, id: string): void {
  const result = prepared(db, `DELETE FROM ${schema}.${ENTITY_TABLES[kind]} WHERE id=?`).run(id);
  if (Number(result.changes) !== 1) invalidFormat5Timeline();
}

/** Persist one prepared entity delta inside the caller's transaction. The
 * caller owns the single content-stamp bump for the transaction. */
export function applyFormat5TimelineEntityUpdateInside(db: DatabaseSync, schema: ProjectSchema, update: Format5TimelineEntityUpdate): void {
  if (!db.isTransaction) throw new TypeError('Timeline entity writes require an open transaction');
  for (const kind of ['clip', 'cue'] as const) {
    for (const id of kind === 'clip' ? update.clipDeletes : update.cueDeletes) deleteEntity(db, schema, kind, id);
    for (const change of kind === 'clip' ? update.clipWrites : update.cueWrites) {
      if (!updateEntity(db, schema, kind, change) && !insertEntity(db, schema, kind, update, change)) invalidFormat5Timeline();
    }
  }
}

/** A content table change is stamped once per transaction. Per-row triggers
 * would turn a 1,500-entity batch into 1,500 metadata row updates. */
export function bumpFormat5ContentStampInside(db: DatabaseSync, schema: ProjectSchema): void {
  if (!db.isTransaction) throw new TypeError('Content stamp writes require an open transaction');
  prepared(db, `UPDATE ${schema}.project_file SET contentSequence=contentSequence+1,contentToken=lower(hex(randomblob(16))) WHERE singleton=1`).run();
}

/** Persist a complete timeline record: the header JSON plus native rows. Used by
 * the store.put compatibility path and by conversion after its DDL step. */
export function writeFormat5TimelineInside(db: DatabaseSync, schema: ProjectSchema, timeline: Format5Timeline): void {
  if (!db.isTransaction) throw new TypeError('Timeline writes require an open transaction');
  const headerRaw = JSON.stringify(format5TimelineHeader(timeline));
  const state = readFormat5TimelineState(db, schema);
  const header = format5TimelineHeader(timeline);
  const clipOld = new Map(state.clips.map(row => [row.id, row])), cueOld = new Map(state.cues.map(row => [row.id, row]));
  const clipWrites: Format5TimelineEntityChange[] = [], cueWrites: Format5TimelineEntityChange[] = [];
  const nextClips = new Set<string>(), nextCues = new Set<string>();
  for (const clip of timeline.clips) {
    const entity = withColumns(clipEntity(clip, header), clipOld.get(clip.id));
    if (nextClips.has(entity.id)) return invalidFormat5Timeline();
    nextClips.add(entity.id);
    if (clipOld.get(entity.id)?.raw !== entity.raw) clipWrites.push(entity);
  }
  for (const cue of timeline.subtitles?.cues ?? []) {
    const entity = withColumns(cueEntity(cue, header), cueOld.get(cue.id));
    if (nextCues.has(entity.id)) return invalidFormat5Timeline();
    nextCues.add(entity.id);
    if (cueOld.get(entity.id)?.raw !== entity.raw) cueWrites.push(entity);
  }
  if (!state.header) {
    prepared(db, `INSERT INTO ${schema}.timelines(id,projectId,data) VALUES(?,?,?)`).run(timeline.id, timeline.projectId, headerRaw);
  } else if (state.header.id !== timeline.id || state.header.projectId !== timeline.projectId) return invalidFormat5Timeline();
  else if (state.header.raw !== headerRaw) prepared(db, `UPDATE ${schema}.timelines SET data=? WHERE id=?`).run(headerRaw, timeline.id);
  applyFormat5TimelineEntityUpdateInside(db, schema, {
    timelineId: timeline.id, projectId: timeline.projectId, clipWrites, cueWrites,
    clipDeletes: [...clipOld.keys()].filter(id => !nextClips.has(id)),
    cueDeletes: [...cueOld.keys()].filter(id => !nextCues.has(id)),
  });
}

/** Store.put compatibility entry: validation happens on the complete incoming
 * record, so the generic whole-row surface keeps its old guarantees. */
export function putFormat5TimelineInside(db: DatabaseSync, schema: ProjectSchema, value: unknown, projectId: string): void {
  if (!object(value) || value.projectId !== projectId) return invalidFormat5Timeline();
  const problem = getFormat5TimelineIssue(value, {projectId});
  if (problem) throw entityError(problem);
  writeFormat5TimelineInside(db, schema, value as unknown as Format5Timeline);
  bumpFormat5ContentStampInside(db, schema);
}

/** Conversion after its DDL step: insert every clip and cue of a validated
 * plan into the new native tables. The header row is written by the caller
 * before the structure upgrade so a crash window keeps the old pair. */
export function insertFormat5TimelineEntitiesInside(db: DatabaseSync, schema: ProjectSchema, timeline: Format5Timeline): void {
  if (!db.isTransaction) throw new TypeError('Timeline entity writes require an open transaction');
  const header = format5TimelineHeader(timeline);
  const update: Format5TimelineEntityUpdate = {timelineId: timeline.id, projectId: timeline.projectId,
    clipWrites: [], cueWrites: [], clipDeletes: [], cueDeletes: []};
  for (const clip of timeline.clips) insertEntity(db, schema, 'clip', update, {...clipEntity(clip, header), setColumns: COLUMNS_OF.clip});
  for (const cue of timeline.subtitles?.cues ?? []) insertEntity(db, schema, 'cue', update, {...cueEntity(cue, header), setColumns: COLUMNS_OF.cue});
}

/** Public entity delta write API. One transaction applies only changed rows, so
 * unrelated clip and cue bytes never move and no revision advances spuriously. */
export function applyFormat5TimelineEntities(store: Format5TimelineEntityWriter, patch: Format5TimelineEntityPatch): Format5TimelineEntityUpdatePlan {
  return store.tx(() => {
    const state = readFormat5TimelineState(store.db, 'project');
    if (!state.header || state.header.projectId !== store.projectId) return invalidFormat5Timeline();
    const plan = planFormat5TimelineEntityUpdate(state, patch);
    if (plan.changed) {
      applyFormat5TimelineEntityUpdateInside(store.db, 'project', plan);
      bumpFormat5ContentStampInside(store.db, 'project');
    }
    return plan;
  });
}

/** Remove one timeline and its native entity rows inside the caller's
 * transaction; the content stamp is advanced once by the caller. */
export function deleteFormat5TimelineInside(db: DatabaseSync, schema: ProjectSchema, timelineId: string): void {
  if (!db.isTransaction) throw new TypeError('Timeline deletion requires an open transaction');
  prepared(db, `DELETE FROM ${schema}.timeline_clips WHERE timelineId=?`).run(timelineId);
  prepared(db, `DELETE FROM ${schema}.timeline_cues WHERE timelineId=?`).run(timelineId);
  prepared(db, `DELETE FROM ${schema}.timelines WHERE id=?`).run(timelineId);
}

// ---------------------------------------------------------------------------
// Commit fence: indexed SQL cross-row invariants over the native columns plus
// bounded graph validation in format5-content. Per-row grammar is enforced by
// CHECK constraints, the entity write path and the full open validator; the
// fence never re-parses the aggregate.
// ---------------------------------------------------------------------------

const VIDEO_MIMES = "'image/png','image/jpeg','image/webp','video/mp4','video/webm'";
const AUDIO_MIMES = "'audio/wav','audio/mpeg','audio/mp4'";

function expectNone(db: DatabaseSync, sql: string, params: readonly (string | number)[] = []): void {
  const row = prepared(db, sql).get(...params);
  if (Number(Object.values(row ?? {})[0]) !== 0) invalidFormat5Timeline();
}
function scalar(db: DatabaseSync, sql: string, params: readonly (string | number)[] = []): number {
  const row = prepared(db, sql).get(...params);
  return Number(Object.values(row ?? {})[0]);
}

export interface Format5TimelineFenceResult {readonly header: Format5TimelineHeader | null;}

/** Terminal fence for the timeline row storage. Ordered so the cheapest
 * association/capacity checks fail before the row joins. */
export function fenceFormat5TimelineRows(db: DatabaseSync, schema: ProjectSchema): Format5TimelineFenceResult {
  const headers = prepared(db, `SELECT id,projectId,CASE WHEN length(CAST(data AS BLOB))<=? THEN data END AS data
    FROM ${schema}.timelines ORDER BY id`).all(FORMAT5_LIMITS.timelineBytes);
  if (headers.length > 1) return invalidFormat5Timeline();
  const headerRow = headers[0];
  if (headerRow && (typeof headerRow.data !== 'string' || typeof headerRow.id !== 'string' || typeof headerRow.projectId !== 'string')) return invalidFormat5Timeline();
  const clips = `${schema}.timeline_clips`, cues = `${schema}.timeline_cues`;
  if (!headerRow) {
    if (scalar(db, `SELECT (SELECT count(*) FROM ${clips})+(SELECT count(*) FROM ${cues})`) !== 0) return invalidFormat5Timeline();
    return {header: null};
  }
  const raw = parseRaw(headerRow.data as string);
  const headerProblem = getFormat5TimelineHeaderIssue(raw, {projectId: headerRow.projectId as string});
  if (headerProblem) return invalidFormat5Timeline();
  const header = raw as unknown as Format5TimelineHeader;
  const timelineId = headerRow.id as string, projectId = headerRow.projectId as string, main = header.mainTrack.trackId;
  const trackList = header.tracks.map(track => `'${String(track.id).replaceAll("'", "''")}'`).join(',');
  const trackKindCase = header.tracks.map(track => `WHEN '${String(track.id).replaceAll("'", "''")}' THEN '${track.kind}'`).join(' ');
  expectNone(db, `SELECT count(*) FROM ${clips} WHERE timelineId<>? OR projectId<>?`, [timelineId, projectId]);
  expectNone(db, `SELECT count(*) FROM ${cues} WHERE timelineId<>? OR projectId<>?`, [timelineId, projectId]);
  // Capacity, track membership and duration.
  const capacity = prepared(db, `SELECT count(*) total,sum(trackId=?) main,sum(trackId<>?) other FROM ${clips}`).get(main, main)!;
  if (Number(capacity.total) > FORMAT5_LIMITS.mainTrackClips + FORMAT5_LIMITS.otherTrackClips ||
      Number(capacity.main) > FORMAT5_LIMITS.mainTrackClips || Number(capacity.other) > FORMAT5_LIMITS.otherTrackClips) return invalidFormat5Timeline();
  if (scalar(db, `SELECT count(*) FROM ${cues}`) > FORMAT5_LIMITS.subtitleCues) return invalidFormat5Timeline();
  expectNone(db, `SELECT count(*) FROM ${clips} c WHERE c.trackId NOT IN (${trackList})`);
  if (scalar(db, `SELECT COALESCE(max(startFrame+durationFrames),0) FROM ${clips}`) !== header.durationFrames) return invalidFormat5Timeline();
  // Same-track overlap for every track (window function over the indexed order).
  expectNone(db, `SELECT count(*) FROM (SELECT startFrame,lag(startFrame+durationFrames) OVER
      (PARTITION BY trackId ORDER BY startFrame,id) prevEnd FROM ${clips}) WHERE prevEnd IS NOT NULL AND startFrame<prevEnd`);
  // Main track: packed from zero, contiguous node groups, one group per node.
  expectNone(db, `SELECT count(*) FROM (SELECT startFrame,sourceNodeId node,segmentGroupId grp,
      lag(startFrame+durationFrames) OVER w prevEnd,lag(sourceNodeId) OVER w prevNode
    FROM ${clips} WHERE trackId=? WINDOW w AS (ORDER BY startFrame,id))
    WHERE (prevEnd IS NULL AND startFrame<>0) OR (prevEnd IS NOT NULL AND startFrame<>prevEnd)
      OR (prevNode IS NOT NULL AND prevNode=node AND grp IS NULL)`, [main]);
  expectNone(db, `SELECT count(*) FROM (SELECT node,count(DISTINCT grp) groups FROM
      (SELECT sourceNodeId node,segmentGroupId grp FROM ${clips} WHERE trackId=?) GROUP BY node HAVING groups<>1)`, [main]);
  expectNone(db, `SELECT count(*) FROM (SELECT grp,count(DISTINCT node) nodes FROM
      (SELECT sourceNodeId node,segmentGroupId grp FROM ${clips} WHERE trackId=?) GROUP BY grp HAVING nodes<>1)`, [main]);
  expectNone(db, `SELECT count(*) FROM (SELECT node,count(*) count,min(ord) lo,max(ord) hi FROM
      (SELECT sourceNodeId node,row_number() OVER (ORDER BY startFrame,id) ord FROM ${clips} WHERE trackId=?)
      GROUP BY node HAVING hi-lo+1<>count)`, [main]);
  // Main-track source grammar and explicit anchor prohibition.
  expectNone(db, `SELECT count(*) FROM ${clips} WHERE trackId=? AND (
      sourceKind IS NULL OR sourceNodeId IS NULL OR segmentGroupId IS NULL OR anchorPresent<>0
      OR (sourceKind='shot' AND versionMode NOT IN ('follow','locked'))
      OR (sourceKind='media' AND versionMode IS NOT NULL))`, [main]);
  expectNone(db, `SELECT count(*) FROM ${clips} WHERE trackId=? AND sourceKind='shot' AND sourceState='ready' AND versionId IS NULL`, [main]);
  // Other-track clips carry an explicit anchor and no source.
  expectNone(db, `SELECT count(*) FROM ${clips} WHERE trackId<>? AND (anchorPresent<>1 OR sourceKind IS NOT NULL)`, [main]);
  // Anchors resolve to a current main-track owner with the exact offset frame.
  expectNone(db, `SELECT count(*) FROM ${clips} c LEFT JOIN ${clips} o ON o.id=c.anchorClipId AND o.timelineId=?
    WHERE c.timelineId=? AND c.trackId<>? AND c.anchorClipId IS NOT NULL
      AND (o.id IS NULL OR o.trackId<>? OR c.startFrame<>o.startFrame+c.anchorOffset
        OR c.anchorOffset<0 OR c.anchorOffset>=o.durationFrames)`, [timelineId, timelineId, main, main]);
  expectNone(db, `SELECT count(*) FROM ${cues} c LEFT JOIN ${clips} o ON o.id=c.anchorClipId AND o.timelineId=?
    WHERE c.timelineId=? AND c.anchorClipId IS NOT NULL
      AND (o.id IS NULL OR o.trackId<>? OR c.startFrame<>o.startFrame+c.anchorOffset
        OR c.anchorOffset<0 OR c.anchorOffset>=o.durationFrames)`, [timelineId, timelineId, main]);
  // Cue overlap and dialogue identity.
  expectNone(db, `SELECT count(*) FROM (SELECT startFrame,lag(startFrame+durationFrames) OVER
      (ORDER BY startFrame,id) prevEnd FROM ${cues} WHERE timelineId=?) WHERE prevEnd IS NOT NULL AND startFrame<prevEnd`, [timelineId]);
  expectNone(db, `SELECT count(*) FROM (SELECT dialogueShotId,dialogueLineId,count(*) n FROM ${cues}
      WHERE timelineId=? AND dialogueShotId IS NOT NULL GROUP BY 1,2 HAVING n>1)`, [timelineId]);
  expectNone(db, `SELECT count(*) FROM ${cues} c WHERE c.timelineId=? AND c.dialogueShotId IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM ${schema}.shots s WHERE s.id=c.dialogueShotId AND s.projectId=c.projectId AND EXISTS(
      SELECT 1 FROM json_each(CASE WHEN json_type(s.data,'$.dialogue')='array' THEN json_extract(s.data,'$.dialogue') ELSE '[]' END) line
      WHERE json_extract(line.value,'$.id')=c.dialogueLineId AND json_extract(line.value,'$.text')=json_extract(c.data,'$.text')))`, [timelineId]);
  // Every ready clip owns a live asset with a track-compatible mime and a source
  // range that fits its duration (asset facts are parsed once per asset).
  expectNone(db, `SELECT count(*) FROM ${clips} c WHERE c.timelineId=? AND c.sourceState='ready'
    AND NOT EXISTS(SELECT 1 FROM ${schema}.assets a WHERE a.id=c.assetId AND a.projectId=c.projectId)`, [timelineId]);
  expectNone(db, `WITH asset_facts AS (SELECT id,json_extract(data,'$.mimeType') mime,json_extract(data,'$.duration') duration FROM ${schema}.assets)
    SELECT count(*) FROM ${clips} c JOIN asset_facts a ON a.id=c.assetId
    WHERE c.timelineId=? AND c.sourceState='ready' AND (
      (CASE c.trackId ${trackKindCase} END='video' AND a.mime NOT IN (${VIDEO_MIMES})) OR
      (CASE c.trackId ${trackKindCase} END='audio' AND a.mime NOT IN (${AUDIO_MIMES})) OR
      (a.mime LIKE 'image/%' AND c.sourceInFrame<>0) OR
      (a.mime NOT LIKE 'image/%' AND (typeof(a.duration) NOT IN ('integer','real') OR
        c.sourceInFrame+c.durationFrames>CAST(a.duration*30+0.000001 AS INTEGER))))`, [timelineId]);
  // Versioned rows prove the same ownership evidence the write path and the
  // full validator use.
  expectNone(db, `WITH version_facts AS (SELECT v.id,v.projectId,json_extract(v.data,'$.assetId') assetId,
      json_extract(v.data,'$.shotId') shotId,json_extract(v.data,'$.jobId') jobId,json_extract(v.data,'$.sha256') sha256 FROM ${schema}.versions v
      WHERE v.id IN (SELECT versionId FROM ${clips} WHERE versionId IS NOT NULL)),
      asset_hashes AS (SELECT id,projectId,json_extract(data,'$.sha256') sha256 FROM ${schema}.assets)
    SELECT count(*) FROM ${clips} c LEFT JOIN version_facts v ON v.id=c.versionId AND v.projectId=c.projectId
      LEFT JOIN asset_hashes a ON a.id=v.assetId AND a.projectId=c.projectId
    WHERE c.timelineId=? AND c.versionId IS NOT NULL AND (
      v.id IS NULL OR v.assetId IS NOT c.assetId OR v.shotId IS NULL OR v.jobId IS NULL
      OR a.id IS NULL OR a.sha256 IS NOT v.sha256
      OR (c.shotId IS NOT NULL AND c.shotId<>v.shotId) OR (c.jobId IS NOT NULL AND c.jobId<>v.jobId)
      OR (c.sourceKind='shot' AND v.shotId<>c.sourceNodeId
        AND NOT EXISTS(SELECT 1 FROM ${schema}.shot_version_adoptions ad WHERE ad.shotId=c.sourceNodeId AND ad.versionId=v.id)))`, [timelineId]);
  // Fixed-media main clips keep the media node as the source of their asset.
  expectNone(db, `SELECT count(*) FROM ${clips} c WHERE c.timelineId=? AND c.sourceKind='media'
    AND NOT EXISTS(SELECT 1 FROM ${schema}.nodes n WHERE n.id=c.sourceNodeId AND n.projectId=c.projectId AND n.archivedAt IS NULL
      AND json_extract(n.data,'$.assetId') IS c.assetId)`, [timelineId]);
  // Stored byte budget: header JSON plus both entity tables.
  const bytes = scalar(db, `SELECT (SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) FROM ${clips})
    +(SELECT COALESCE(sum(length(CAST(data AS BLOB))),0) FROM ${cues})+?`, [Buffer.byteLength(headerRow.data as string)]);
  if (bytes > FORMAT5_LIMITS.timelineBytes) return invalidFormat5Timeline();
  return {header};
}
