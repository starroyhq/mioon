import type {CanvasTarget, CanvasTargetExpectation} from '../../contracts/src/canvas-editing.ts';
import {CANVAS_EDIT_LIMITS} from '../../contracts/src/canvas-editing.ts';
import {isProjectId} from '../../contracts/src/project-file.ts';
import {INSPECTION_ROW_LIMITS} from './inspection-query.ts';
import type {ProjectStore} from './project-file/store.ts';
import {
  activeShotPositions, canvasError, canvasKey, canvasLimit, compareCanvasTargets, expectCanvasRows, newCanvasArchive,
  previousFields, readCanvasOrderAnchor, readCanvasRow,
} from './canvas-patch.ts';
import type {CanvasFields, CanvasOrderAnchor, CanvasPatch, CanvasRow} from './canvas-patch.ts';

interface Edge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: 'decor' | 'reference';
  readonly role: 'first_frame' | null;
  readonly sourceAssetId: string | null;
  readonly archived: boolean;
}

function readEdges(store: ProjectStore, endpointIds: readonly string[], edgeIds: readonly string[]): Edge[] {
  if (!endpointIds.length && !edgeIds.length) return [];
  const rows = store.db.prepare(`WITH endpoints AS (SELECT value AS id FROM json_each(?)),
    explicit AS (SELECT value AS id FROM json_each(?)), edges AS (
      SELECT id,archivedAt,CASE WHEN length(CAST(data AS BLOB))<=${INSPECTION_ROW_LIMITS.edges}
        THEN CASE WHEN json_valid(data) THEN data END END AS data
      FROM project.edges WHERE projectId=?
    ), decoded AS (SELECT id,archivedAt,
      json_extract(data,'$.id') IS id AND json_extract(data,'$.projectId') IS ? AS owned,
      CASE WHEN length(json_extract(data,'$.source'))=36 THEN json_extract(data,'$.source') END AS source,
      CASE WHEN length(json_extract(data,'$.target'))=36 THEN json_extract(data,'$.target') END AS target,
      CASE WHEN json_type(data,'$.kind') IS NULL OR json_extract(data,'$.kind')='decorative' THEN 'decor'
        WHEN json_extract(data,'$.kind')='reference' THEN 'reference' END AS kind,
      CASE WHEN json_extract(data,'$.role')='first_frame' THEN 'first_frame' END AS role,
      CASE WHEN length(json_extract(data,'$.sourceAssetId'))=36 THEN json_extract(data,'$.sourceAssetId') END AS sourceAssetId
    FROM edges), slots AS (
      SELECT *,CASE WHEN kind='reference' THEN 'reference:'||target WHEN kind='decor' THEN 'decor:'||source||':'||target END AS slot
      FROM decoded
    ) SELECT id,archivedAt,owned,source,target,kind,role,sourceAssetId FROM slots
    WHERE id IN (SELECT id FROM explicit) OR source IN (SELECT id FROM endpoints) OR target IN (SELECT id FROM endpoints)
      OR slot IN (SELECT slot FROM slots WHERE id IN (SELECT id FROM explicit))
    ORDER BY id LIMIT ?`).all(JSON.stringify(endpointIds), JSON.stringify(edgeIds), store.projectId, store.projectId,
    CANVAS_EDIT_LIMITS.effects + 1);
  if (rows.length > CANVAS_EDIT_LIMITS.effects) return canvasLimit();
  return rows.map(row => {
    if (row.owned !== 1 || !isProjectId(row.id) || !isProjectId(row.source) || !isProjectId(row.target) ||
      row.kind !== 'decor' && row.kind !== 'reference') return canvasError('invalid-edge');
    return {id: row.id, source: row.source, target: row.target, kind: row.kind,
      role: row.role === 'first_frame' ? row.role : null, sourceAssetId: isProjectId(row.sourceAssetId) ? row.sourceAssetId : null,
      archived: row.archivedAt !== null};
  });
}

/** A new edge has no revision in the original patch. Bind its presence as
 * well so replay cannot hide or reactivate a relationship added later. */
export function canvasEdgeEvidence(store: ProjectStore, patch: Pick<CanvasPatch, 'rows'>): readonly Edge[] {
  const changed = patch.rows.filter(row => row.fields.archive !== undefined);
  return readEdges(store, changed.filter(row => row.kind !== 'edge').map(row => row.id), changed.filter(row => row.kind === 'edge').map(row => row.id));
}

const edgeSlot = (edge: Edge): string => edge.kind === 'reference' ? `reference:${edge.target}` : `decor:${edge.source}:${edge.target}`;

function endpoint(store: ProjectStore, id: string): CanvasRow {
  const node = store.db.prepare('SELECT id FROM project.nodes WHERE id=? AND projectId=?').get(id, store.projectId);
  const shot = store.db.prepare('SELECT id FROM project.shots WHERE id=? AND projectId=?').get(id, store.projectId);
  if (Boolean(node) === Boolean(shot)) return canvasError('edge-endpoint', {id});
  return readCanvasRow(store, {kind: node ? 'node' : 'shot', id});
}

function verifyFirstFrame(store: ProjectStore, edge: Edge, source: CanvasRow, shot: CanvasRow): void {
  const refs = shot.data.referenceAssetIds;
  if (source.kind !== 'node' || shot.kind !== 'shot' || source.data.type !== 'image' || edge.role !== 'first_frame' ||
    !isProjectId(edge.sourceAssetId) || source.data.assetId !== edge.sourceAssetId ||
    !Array.isArray(refs) || refs.length !== 1 || refs[0] !== edge.sourceAssetId ||
    !store.db.prepare('SELECT id FROM project.assets WHERE id=? AND projectId=?').get(edge.sourceAssetId, store.projectId)) {
    canvasError('reference-binding', {id: edge.id});
  }
}

/** Recheck live slot and edge uniqueness even when the conflicting edge
 * didn't exist when the operation entered the undo stack. */
export function assertCanvasEdgeEffects(store: ProjectStore, patch: Pick<CanvasPatch, 'rows'>): void {
  const activating = new Set(patch.rows.filter(row => row.kind === 'edge' && row.fields.archive === null).map(row => row.id));
  const hidingNodes = new Set(patch.rows.filter(row => row.kind === 'node' && row.fields.archive).map(row => row.id));
  if (!activating.size && !hidingNodes.size) return;
  const edges = readEdges(store, [...hidingNodes], [...activating]), changes = new Map(patch.rows.map(row => [canvasKey(row), row.fields]));
  const afterArchived = (row: CanvasRow) => {
    const change = changes.get(canvasKey(row));
    return change?.archive === undefined ? row.archive !== null : change.archive !== null;
  };
  const afterActiveEdge = (edge: Edge): boolean => {
    const change = changes.get(canvasKey({kind: 'edge', id: edge.id}));
    return change?.archive === undefined ? !edge.archived : change.archive === null;
  };
  const counts = new Map<string, number>();
  for (const edge of edges) if (afterActiveEdge(edge)) {
    const slot = edgeSlot(edge);
    counts.set(slot, (counts.get(slot) ?? 0) + 1);
  }
  for (const edge of edges) {
    if (edge.kind === 'reference' && hidingNodes.has(edge.source) && afterActiveEdge(edge)) return canvasError('reference-source', {id: edge.id});
    if (!activating.has(edge.id)) continue;
    const source = endpoint(store, edge.source), shot = endpoint(store, edge.target);
    if (afterArchived(source) || edge.kind === 'decor' && afterArchived(shot)) return canvasError('edge-endpoint', {id: edge.id});
    if (edge.kind === 'reference') verifyFirstFrame(store, edge, source, shot);
    if (counts.get(edgeSlot(edge)) !== 1) {
      return canvasError('edge-duplicate', {id: edge.id});
    }
  }
}

function restoredOrder(original: readonly string[], restored: readonly string[], anchors: readonly CanvasOrderAnchor[]): string[] {
  const order = [...original], known = new Map(anchors.map(anchor => [anchor.id, anchor]));
  const lastAfter = new Map<string, string>();
  for (const id of restored) {
    const anchor = known.get(id);
    const next = anchor?.next ? order.indexOf(anchor.next) : -1;
    const previous = anchor?.previous ? order.lastIndexOf(lastAfter.get(anchor.previous) ?? anchor.previous) : -1;
    order.splice(next >= 0 ? next : previous >= 0 ? previous + 1 : order.length, 0, id);
    if (next < 0 && previous >= 0 && anchor?.previous) lastAfter.set(anchor.previous, id);
  }
  return order;
}

export function planCanvasArchive(store: ProjectStore, operation: 'archive' | 'restore', targets: readonly CanvasTargetExpectation[],
  at: string, batchId?: string) {
  const restoring = operation === 'restore', selected = expectCanvasRows(store, targets, restoring), archive = newCanvasArchive(at);
  if (batchId) {
    if (!restoring || selected.some(row => row.archive?.batchId !== batchId || row.archive.reason !== 'user-delete')) {
      return canvasError('archive-batch');
    }
    const remaining = ['shots', 'nodes', 'edges'].reduce((sum, table) => sum + Number(store.db.prepare(
      `SELECT count(*) AS count FROM project.${table} WHERE projectId=? AND archiveBatchId=? AND archiveReason='user-delete'`,
    ).get(store.projectId, batchId)?.count), 0);
    if (remaining !== selected.length) return canvasError('archive-batch');
  }
  const changed = new Map<string, {row: CanvasRow; fields: CanvasFields}>();
  const guards = new Map<string, CanvasTarget>();
  const add = (row: CanvasRow, fields: CanvasFields) => {
    const key = canvasKey(row);
    changed.set(key, {row, fields: {...changed.get(key)?.fields, ...fields}});
  };
  function guard({kind, id}: CanvasTarget): void { guards.set(canvasKey({kind, id}), {kind, id}); }
  const edgeIds = selected.filter(row => row.kind === 'edge').map(row => row.id);
  const endpointIds = selected.filter(row => row.kind !== 'edge').map(row => row.id);
  let edges = readEdges(store, endpointIds, edgeIds);
  // A source archive needs the complete first-frame slot, including other
  // sources that do not touch the selected node.
  if (!restoring) {
    const selectedNodes = new Set(selected.filter(row => row.kind === 'node').map(row => row.id));
    const referenceIds = edges.filter(edge => !edge.archived && edge.kind === 'reference' && selectedNodes.has(edge.source)).map(edge => edge.id);
    if (referenceIds.length) edges = readEdges(store, endpointIds, [...edgeIds, ...referenceIds]);
  }
  const edgesById = new Map(edges.map(edge => [edge.id, edge]));
  const endpoints = new Map<string, CanvasRow>();
  function readEndpoint(id: string): CanvasRow {
    const known = endpoints.get(id);
    if (known) return known;
    const row = endpoint(store, id);
    endpoints.set(id, row);
    return row;
  }
  const referenceCounts = new Map<string, number>();
  for (const edge of edges) if (!edge.archived && edge.kind === 'reference') {
    referenceCounts.set(edge.target, (referenceCounts.get(edge.target) ?? 0) + 1);
  }
  for (const row of selected) {
    if (row.kind === 'edge') {
      const edge = edgesById.get(row.id);
      if (edge?.kind !== 'decor' || restoring && row.archive?.reason !== 'user-delete') return canvasError('explicit-reference', {id: row.id});
      const source = readEndpoint(edge.source), target = readEndpoint(edge.target);
      if (!restoring && (source.archive || target.archive)) return canvasError('edge-endpoint', {id: row.id});
      guard(source);
      guard(target);
    }
    if (restoring && row.archive?.reason === 'undo-create') return canvasError('undo-created', {id: row.id});
    add(row, {archive: restoring ? null : archive});
    guard(row);
  }
  const affectedNodes = new Map(selected.filter(row => row.kind === 'node').map(row => [row.id, row]));
  const shotSelection = selected.filter(row => row.kind === 'shot');
  const affectedShots = new Set(shotSelection.map(row => row.id));
  for (const edge of edges) {
    const source = affectedNodes.get(edge.source);
    if (!edge.archived && (source || affectedNodes.has(edge.target) || affectedShots.has(edge.source) || affectedShots.has(edge.target))) {
      const target = readEndpoint(edge.target);
      guard(readEndpoint(edge.source));
      guard(target);
      guard({kind: 'edge', id: edge.id});
      if (!restoring && edge.kind === 'reference' && source) {
        verifyFirstFrame(store, edge, source, target);
        if (referenceCounts.get(edge.target) !== 1) {
          return canvasError('reference-binding', {id: edge.id});
        }
        add(readCanvasRow(store, {kind: 'edge', id: edge.id}), {archive: {...archive, reason: 'reference-source'}});
        // Keep the selected asset as a manual slot and advance both revisions.
        const next = changed.get(canvasKey(target))?.fields;
        add(target, {archive: next?.archive === undefined ? target.archive : next.archive});
      }
    }
  }
  const positions = shotSelection.length ? activeShotPositions(store) : null;
  const beforeOrder = positions?.map(row => row.id) ?? null;
  let anchors: readonly CanvasOrderAnchor[] = [];
  let afterOrder: readonly string[] | null = null;
  if (beforeOrder) {
    if (restoring) {
      anchors = shotSelection.map(readCanvasOrderAnchor);
      const sorted = [...shotSelection].sort((a,b) => Number(a.data.orderIndex) - Number(b.data.orderIndex) || compareCanvasTargets(a,b));
      afterOrder = restoredOrder(beforeOrder, sorted.map(row => row.id), anchors);
    } else {
      const nextSurvivor: (string | null)[] = [];
      let next: string | null = null;
      for (let index = beforeOrder.length - 1; index >= 0; index--) {
        nextSurvivor[index] = next;
        if (!affectedShots.has(beforeOrder[index]!)) next = beforeOrder[index]!;
      }
      let previous: string | null = null;
      anchors = beforeOrder.flatMap((id, index) => {
        if (affectedShots.has(id)) return [{id, previous, next: nextSurvivor[index] ?? null, number: index + 1}];
        previous = id;
        return [];
      });
      afterOrder = beforeOrder.filter(id => !affectedShots.has(id));
    }
    const currentPositions = new Map(positions!.map(row => [row.id, row.position]));
    for (const [orderIndex, id] of afterOrder.entries()) {
      const target: CanvasTarget = {kind: 'shot', id};
      const changedRow = changed.get(canvasKey(target))?.row;
      if ((changedRow?.data.orderIndex ?? currentPositions.get(id)) !== orderIndex) {
        // The patch checks the exact order and orderIndex. An unrelated edit
        // to a surviving shot must not invalidate the archive action.
        add(changedRow ?? readCanvasRow(store, target), {orderIndex});
      }
    }
  }
  if (changed.size > CANVAS_EDIT_LIMITS.effects || guards.size > CANVAS_EDIT_LIMITS.effects) return canvasLimit();
  const entries = [...changed.values()].sort((a,b) => compareCanvasTargets(a.row,b.row));
  const guardList = [...guards.values()].sort(compareCanvasTargets);
  const patch = (isBefore: boolean): Omit<CanvasPatch, 'dependencyDigest'> => ({
    version: 1, order: isBefore ? beforeOrder : afterOrder, anchors, guards: guardList,
    rows: entries.map(({row, fields}) => ({kind: row.kind, id: row.id, fields: isBefore ? previousFields(row, fields) : fields})),
  });
  const after = patch(false);
  assertCanvasEdgeEffects(store, after);
  return {before: patch(true), after, selected};
}
