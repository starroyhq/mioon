import {randomUUID} from 'node:crypto';
import type {CanvasTarget, CanvasTargetExpectation} from '../../contracts/src/canvas-editing.ts';
import {CANVAS_EDIT_LIMITS} from '../../contracts/src/canvas-editing.ts';
import type {CanvasPosition} from '../../contracts/src/canvas-position.ts';
import {isProjectId} from '../../contracts/src/project-file.ts';
import {AppError} from '../../contracts/src/app-error.ts';
import {readMioTargetRevision} from './agent/mio-target-revisions.ts';
import {INSPECTION_ROW_LIMITS} from './inspection-query.ts';
import type {ProjectStore} from './project-file/store.ts';

export const canvasError = (reason: string, details: Record<string, unknown> = {}): never => {
  throw new AppError('CANVAS_EDIT_CONFLICT', '画布内容或关联已变化，请重新读取。', 409, {reason, ...details});
};
export const canvasLimit = (): never => {
  throw new AppError('CANVAS_EDIT_CAPACITY', '此次画布操作超出容量。', 409);
};
export const canvasKey = ({kind, id}: CanvasTarget): string => `${kind}:${id}`;
export const compareCanvasTargets = (a: CanvasTarget, b: CanvasTarget): number =>
  a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
export const canvasTables = {shot: 'shots', node: 'nodes', edge: 'edges'} as const;

export interface CanvasArchive {
  readonly at: string;
  readonly batchId: string;
  readonly reason: 'user-delete' | 'undo-create' | 'reference-source';
}
export interface CanvasFields {
  readonly archive?: CanvasArchive | null;
  readonly position?: CanvasPosition | null;
  readonly orderIndex?: number;
}
export interface CanvasRow extends CanvasTarget {
  readonly revision: number;
  readonly data: Record<string, unknown>;
  readonly archive: CanvasArchive | null;
}
export interface CanvasPatchRow extends CanvasTarget {
  readonly fields: CanvasFields;
}
export interface CanvasOrderAnchor {
  readonly id: string;
  readonly previous: string | null;
  readonly next: string | null;
}
export const CANVAS_ARCHIVE_ORDER_FIELD = 'canvasArchiveOrder';
export interface CanvasPatch {
  readonly version: 1;
  readonly rows: readonly CanvasPatchRow[];
  readonly guards: readonly CanvasTarget[];
  readonly anchors: readonly CanvasOrderAnchor[];
  readonly order: readonly string[] | null;
  readonly dependencyDigest: string;
}

const jsonObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const archiveReason = (value: unknown): value is CanvasArchive['reason'] =>
  value === 'user-delete' || value === 'undo-create' || value === 'reference-source';
const token = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const validOrder = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const point = (value: unknown): value is CanvasPosition => jsonObject(value) && typeof value.x === 'number' &&
  Number.isFinite(value.x) && typeof value.y === 'number' && Number.isFinite(value.y);
const target = (value: unknown): value is CanvasTarget => jsonObject(value) && isProjectId(value.id) &&
  (value.kind === 'shot' || value.kind === 'node' || value.kind === 'edge');
const archive = (value: unknown): value is CanvasArchive => jsonObject(value) && Object.keys(value).length === 3 &&
  typeof value.at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value.at) && isProjectId(value.batchId) && archiveReason(value.reason);
const isAnchorPair = (value: Record<string, unknown>): value is Record<string, unknown> & Omit<CanvasOrderAnchor, 'id'> =>
  (value.previous === null || isProjectId(value.previous)) && (value.next === null || isProjectId(value.next));
export const isCanvasOrderAnchor = (value: unknown, id: string): value is Omit<CanvasOrderAnchor, 'id'> =>
  jsonObject(value) && Object.keys(value).length === 2 && isAnchorPair(value) &&
  value.previous !== id && value.next !== id && (value.previous === null || value.previous !== value.next);

export function readCanvasOrderAnchor(shot: CanvasRow): CanvasOrderAnchor {
  const value = shot.data[CANVAS_ARCHIVE_ORDER_FIELD];
  if (value === undefined) return {id: shot.id, previous: null, next: null};
  if (!isCanvasOrderAnchor(value, shot.id)) {
    return canvasError('story-order', {id: shot.id});
  }
  return {id: shot.id, previous: value.previous, next: value.next};
}
function fields(value: unknown): value is CanvasFields {
  return jsonObject(value) && Object.keys(value).length > 0 && Object.keys(value).every(key => {
    if (key === 'archive') return value.archive === null || archive(value.archive);
    if (key === 'position') return value.position === null || point(value.position) && Object.keys(value.position).length === 2;
    return key === 'orderIndex' && validOrder(value.orderIndex);
  });
}
function parseObject(raw: unknown): Record<string, unknown> {
  try {
    const data: unknown = typeof raw === 'string' && Buffer.byteLength(raw) <= 4 * 1024 * 1024 ? JSON.parse(raw) : null;
    return jsonObject(data) ? data : canvasError('invalid-record');
  } catch { return canvasError('invalid-record'); }
}

export function decodeCanvasPatch(raw: unknown): CanvasPatch {
  const rawPatch = parseObject(raw);
  const value = rawPatch.version === 2 ? expandPositionPatch(rawPatch) : rawPatch;
  const isAnchor = (anchor: unknown): anchor is CanvasOrderAnchor => jsonObject(anchor) && Object.keys(anchor).length === 3 &&
    isProjectId(anchor.id) && isAnchorPair(anchor);
  const isPatchRow = (row: unknown): row is CanvasPatchRow => {
    if (!jsonObject(row) || Object.keys(row).length !== 3) return false;
    const change = row.fields;
    return target(row) && fields(change) && (row.kind === 'shot' || change.orderIndex === undefined) &&
      (row.kind !== 'edge' || change.position === undefined);
  };
  const {rows, guards, anchors, order, dependencyDigest} = value;
  if (Object.keys(value).length !== 6 || value.version !== 1 || !token(dependencyDigest) ||
    !Array.isArray(rows) || !rows.length || rows.length > CANVAS_EDIT_LIMITS.effects || !rows.every(isPatchRow) ||
    !Array.isArray(guards) || guards.length > CANVAS_EDIT_LIMITS.effects || !guards.every(item => target(item) && Object.keys(item).length === 2) ||
    !Array.isArray(anchors) || anchors.length > CANVAS_EDIT_LIMITS.targets || !anchors.every(isAnchor) ||
    order !== null && (!Array.isArray(order) || order.length > CANVAS_EDIT_LIMITS.effects || !order.every(isProjectId))) return canvasError('invalid-history');
  const guardKeys = new Set(guards.map(canvasKey));
  if (new Set(rows.map(canvasKey)).size !== rows.length || guardKeys.size !== guards.length || rows.some(row => !guardKeys.has(canvasKey(row))) ||
    new Set(anchors.map(item => item.id)).size !== anchors.length || order && new Set(order).size !== order.length) return canvasError('invalid-history');
  return {version: 1, rows, guards, anchors, order, dependencyDigest};
}

function expandPositionPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const {guards, positions, dependencyDigest} = patch;
  if (Object.keys(patch).length !== 4 || !Array.isArray(guards) || guards.length > CANVAS_EDIT_LIMITS.targets ||
    !guards.every(item => target(item) && item.kind !== 'edge' && Object.keys(item).length === 2) ||
    !Array.isArray(positions) || positions.length > guards.length) return canvasError('invalid-history');
  const rows = positions.map(item => {
    if (!Array.isArray(item) || !validOrder(item[0]) || item[0] >= guards.length) return canvasError('invalid-history');
    const position = item.length === 2 && item[1] === null ? null : {x: item[1], y: item[2]};
    if (position !== null && (item.length !== 3 || !point(position))) return canvasError('invalid-history');
    return {...guards[item[0]], fields: {position}};
  });
  return {version: 1, rows, guards, anchors: [], order: null, dependencyDigest};
}

export function encodeCanvasPatch(patch: CanvasPatch): string {
  if (patch.order !== null || patch.anchors.length || patch.rows.some(row => row.fields.position === undefined ||
    Object.keys(row.fields).length !== 1)) return JSON.stringify(patch);
  // Reuse guard identities so both sides of a full layout fit the kernel's
  // shared one-megabyte history budget even with fractional coordinates.
  const indices = new Map(patch.guards.map((guard, index) => [canvasKey(guard), index]));
  const positions = patch.rows.map(row => {
    const index = indices.get(canvasKey(row)) ?? canvasError('invalid-history');
    const position = row.fields.position;
    return position ? [index, position.x, position.y] : [index, null];
  });
  return JSON.stringify({version: 2, guards: patch.guards, positions, dependencyDigest: patch.dependencyDigest});
}

export function readCanvasRow(store: ProjectStore, item: CanvasTarget): CanvasRow {
  const table = canvasTables[item.kind];
  const row = store.db.prepare(`SELECT CASE WHEN length(CAST(data AS BLOB))<=${INSPECTION_ROW_LIMITS[table]} THEN data END AS data,
    archivedAt,archiveBatchId,archiveReason FROM project.${table} WHERE id=? AND projectId=?`)
    .get(item.id, store.projectId);
  if (!row) return canvasError('missing', item);
  const data = parseObject(row.data);
  if (data.id !== item.id || data.projectId !== store.projectId) return canvasError('invalid-record', item);
  const archived = row.archivedAt === null ? null : {at: row.archivedAt, batchId: row.archiveBatchId, reason: row.archiveReason};
  if (archived !== null && !archive(archived)) return canvasError('invalid-record', item);
  const revision = readMioTargetRevision(store.db, store.projectId, item.kind, item.id);
  if (revision === undefined) return canvasError('invalid-revision', item);
  return {...item, revision, data, archive: archived as CanvasArchive | null};
}

export function expectCanvasRows(store: ProjectStore, selection: readonly CanvasTargetExpectation[], archived: boolean): CanvasRow[] {
  const sorted = [...selection].sort(compareCanvasTargets);
  if (new Set(sorted.map(canvasKey)).size !== sorted.length) return canvasError('duplicate-target');
  return sorted.map(item => {
    const row = readCanvasRow(store, {id: item.id, kind: item.kind});
    if (row.revision !== item.revision || (row.archive !== null) !== archived) return canvasError('target-revision', item);
    return row;
  });
}

export function activeShotPositions(store: ProjectStore): {id: string; position: number}[] {
  const rows = store.db.prepare(`SELECT id, CASE WHEN json_valid(data) THEN json_extract(data,'$.orderIndex') END AS position
    FROM project.shots WHERE projectId=? AND archivedAt IS NULL ORDER BY position,id LIMIT ?`).all(store.projectId, CANVAS_EDIT_LIMITS.effects + 1);
  if (rows.length > CANVAS_EDIT_LIMITS.effects) return canvasLimit();
  return rows.map(({id, position}) => {
    if (!isProjectId(id) || !validOrder(position)) return canvasError('story-order');
    return {id, position};
  });
}

export function activeShotOrder(store: ProjectStore): string[] {
  return activeShotPositions(store).map(({id}) => id);
}

function rowFields(row: CanvasRow, shape: CanvasFields): CanvasFields {
  const position = row.data.position;
  const index = row.data.orderIndex;
  if (shape.position !== undefined && position !== undefined && !point(position)) return canvasError('invalid-position', {id: row.id});
  if (shape.orderIndex !== undefined && !validOrder(index)) return canvasError('story-order', {id: row.id});
  return {
    ...(shape.archive !== undefined ? {archive: row.archive} : {}),
    ...(shape.position !== undefined ? {position: point(position) ? {x: position.x, y: position.y} : null} : {}),
    ...(shape.orderIndex !== undefined ? {orderIndex: index as number} : {}),
  };
}

export function previousFields(row: CanvasRow, shape: CanvasFields): CanvasFields { return rowFields(row, shape); }
const fieldIdentity = (value: CanvasFields): string => JSON.stringify([value.archive, value.position, value.orderIndex]);

export function applyCanvasPatch(store: ProjectStore, before: CanvasPatch, after: CanvasPatch, at: string): void {
  if (!store.db.isTransaction) throw new TypeError('Canvas patch requires the project transaction');
  if (before.order && JSON.stringify(activeShotOrder(store)) !== JSON.stringify(before.order)) return canvasError('story-order');
  if (before.rows.length !== after.rows.length) return canvasError('invalid-history');
  const current = before.rows.map((expected, index) => {
    const row = readCanvasRow(store, expected);
    const next = after.rows[index]!;
    if (canvasKey(next) !== canvasKey(expected) || Object.keys(next.fields).sort().join() !== Object.keys(expected.fields).sort().join() ||
      fieldIdentity(rowFields(row, expected.fields)) !== fieldIdentity(expected.fields)) return canvasError('patch-base', {id: row.id});
    return row;
  });
  const anchors = new Map(after.anchors.map(anchor => [anchor.id, anchor]));
  for (const [index, row] of current.entries()) {
    const update = after.rows[index]!.fields;
    const data = {...row.data};
    if (update.position !== undefined) {
      if (update.position === null) delete data.position;
      else data.position = update.position;
    }
    if (update.orderIndex !== undefined) data.orderIndex = update.orderIndex;
    if (row.kind !== 'edge') {
      if (!validOrder(data.revision) || data.revision >= Number.MAX_SAFE_INTEGER) return canvasError('revision-limit', {id: row.id});
      data.revision++;
      if (row.kind === 'shot' || Object.hasOwn(data, 'updatedAt')) data.updatedAt = at;
    }
    if (row.kind === 'shot' && update.archive !== undefined) {
      if (update.archive?.reason === 'user-delete') {
        const anchor = anchors.get(row.id) ?? readCanvasOrderAnchor(row);
        data[CANVAS_ARCHIVE_ORDER_FIELD] = {previous: anchor.previous, next: anchor.next};
      } else delete data[CANVAS_ARCHIVE_ORDER_FIELD];
    }
    const mark = update.archive === undefined ? row.archive : update.archive;
    const write = store.db.prepare(`UPDATE project.${canvasTables[row.kind]} SET data=?, archivedAt=?,archiveBatchId=?,archiveReason=? WHERE id=? AND projectId=?`)
      .run(JSON.stringify(data), mark?.at ?? null, mark?.batchId ?? null, mark?.reason ?? null, row.id, store.projectId);
    if (write.changes !== 1) return canvasError('missing', {id: row.id});
  }
  if (after.order && JSON.stringify(activeShotOrder(store)) !== JSON.stringify(after.order)) return canvasError('story-order');
  if (before.order && after.order && JSON.stringify(before.order) !== JSON.stringify(after.order)) {
    const project = parseObject(store.db.prepare('SELECT data FROM project.projects WHERE id=?').get(store.projectId)?.data);
    if (project.id !== store.projectId || !validOrder(project.revision) || project.revision >= Number.MAX_SAFE_INTEGER) {
      return canvasError('project-revision');
    }
    store.put('projects', {...project, revision: project.revision + 1, updatedAt: at});
  }
}

/** New deletes get a stable batch ID that redo reuses. */
export const newCanvasArchive = (at: string): CanvasArchive => ({at, batchId: randomUUID(), reason: 'user-delete'});
