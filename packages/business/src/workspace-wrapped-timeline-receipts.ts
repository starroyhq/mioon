/** Wrapped timeline receipts for the frozen audio-role and colour row scanners.
 * Their shared workspace40/41 receipt adapter (workspace-frozen-evidence-v40.ts)
 * predates receipts that wrap the saved timeline with their outcomes, reads any
 * receipt with a `timeline` key as a render receipt and rejects it. Such
 * receipts exist from schema56 on; the frozen modules stay byte-exact. */
import type {DatabaseSync, SQLInputValue, SQLOutputValue} from 'node:sqlite';
import {requireWorkspaceEnvelopeRuntime} from './workspace-envelope-runtime.ts';
import {TIMELINE_SHOT_SYNC_OPERATIONS} from '../../contracts/src/timeline-shot-sync.ts';
import {TIMELINE_SCENE_SPLIT_OPERATION} from '../../contracts/src/timeline-scene-split.ts';
import {TIMELINE_CROSSFADE_OPERATION} from '../../contracts/src/timeline-crossfade.ts';

/** Operations whose receipt is {operation, requestId, timeline, ...outcomes}. */
export const WRAPPED_TIMELINE_OPERATIONS: readonly string[] = Object.freeze([...TIMELINE_SHOT_SYNC_OPERATIONS, TIMELINE_SCENE_SPLIT_OPERATION, TIMELINE_CROSSFADE_OPERATION]);

type Row = Record<string, SQLOutputValue>;
const JSON_BYTES = 4 * 1024 * 1024;
// Keys the scanners read as audio-role or colour evidence, and the keys their
// receipt adapter reads as a render receipt.
const evidenceKeys = new Set(['audioRole', 'audioRoleProfile', 'colour', 'colourPlan', 'profileId', 'timeline', 'snapshot', 'assets']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(): never {throw Object.assign(new Error('Workspace receipt view is read-only.'), {code: 'RESTORE_SCHEMA_UNSUPPORTED'});}

function carriesEvidence(root: unknown): boolean {
  const pending = [{value: root, depth: 0}]; let nodes = 0;
  while (pending.length) {
    const {value, depth} = pending.pop()!;
    if (++nodes > 200000 || depth > 128) return true;
    if (value === null || typeof value !== 'object') continue;
    if (!Array.isArray(value) && Object.keys(value).some(key => evidenceKeys.has(key))) return true;
    for (const child of Object.values(value)) pending.push({value: child, depth: depth + 1});
  }
  return false;
}

/** A read-only view in which each wrapped receipt that is bound to its row,
 * carries a valid timeline record and has no evidence in its outcomes reads as
 * that timeline. The scanners then check its clips against the saved assets
 * like any bare mutation receipt. Any other wrapped receipt is left as stored,
 * so the scanners still reject it when it carries evidence. Catalog reads, SQL
 * computed columns and every other cell pass through unchanged. */
export function wrappedTimelineReceiptView(db: Pick<DatabaseSync, 'prepare'>): Pick<DatabaseSync, 'prepare'> {
  const catalog = db.prepare("SELECT type, CASE WHEN length(CAST(sql AS BLOB)) <= 131072 THEN sql END AS sql FROM main.sqlite_schema WHERE name COLLATE NOCASE = 'timeline_requests'").all();
  // An unexpected catalog stays with the scanners, which fail closed on it.
  if (catalog.length !== 1 || catalog[0]!.type !== 'table' || typeof catalog[0]!.sql !== 'string' || /^\s*CREATE\s+VIRTUAL\s+TABLE/iu.test(catalog[0]!.sql)) return db;
  let isTimelineRecord: (value: unknown, options?: Readonly<{projectId?: unknown}>) => boolean;
  try {({isTimelineRecord} = requireWorkspaceEnvelopeRuntime());} catch {return db;}
  const projections = new Map<string, string>();
  const query = `SELECT CASE WHEN typeof(requestId)='text' AND length(CAST(requestId AS BLOB))<=800 THEN requestId END AS identity, response AS value
    FROM main.timeline_requests WHERE typeof(response)='text' AND length(CAST(response AS BLOB)) BETWEEN 1 AND ${JSON_BYTES}
    AND json_valid(response) AND json_type(response)='object' AND json_extract(response,'$.operation') IN (${WRAPPED_TIMELINE_OPERATIONS.map(() => '?').join(',')})`;
  for (const row of db.prepare(query).iterate(...WRAPPED_TIMELINE_OPERATIONS)) {
    let root: unknown;
    try {root = JSON.parse(row.value as string);} catch {continue;}
    if (!object(root) || !WRAPPED_TIMELINE_OPERATIONS.includes(root.operation as string)) continue;
    const {timeline, ...outcomes} = root;
    if (root.requestId !== row.identity || !object(timeline) || !isTimelineRecord(timeline, {projectId: timeline.projectId}) || carriesEvidence(outcomes)) continue;
    projections.set(row.value as string, JSON.stringify(timeline));
  }
  if (!projections.size) return db;
  const project = (row: Row | undefined): Row | undefined => {
    if (!row) return row;
    const result = {...row};
    for (const [key, value] of Object.entries(result)) if (typeof value === 'string' && projections.has(value)) result[key] = projections.get(value)!;
    return result;
  };
  return {prepare(sql: string) {
    if (!/^\s*(?:SELECT|PRAGMA)\b/iu.test(sql)) invalid();
    const statement = db.prepare(sql);
    return new Proxy(statement, {get(target, key) {
      if (key === 'get') return (...args: SQLInputValue[]) => project(target.get(...args));
      if (key === 'all') return (...args: SQLInputValue[]) => target.all(...args).map(row => project(row)!);
      if (key === 'iterate') return function* (...args: SQLInputValue[]) {for (const row of target.iterate(...args)) yield project(row)!;};
      if (key === 'run') return () => invalid();
      const member: unknown = Reflect.get(target, key, target);
      return typeof member === 'function' ? member.bind(target) : member;
    }});
  }};
}
