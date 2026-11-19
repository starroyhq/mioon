import {randomUUID} from 'node:crypto';
import {lstatSync} from 'node:fs';
import {CANVAS_CLIPBOARD_LIMITS, CANVAS_EDIT_LIMITS} from '../../contracts/src/canvas-editing.ts';
import type {CanvasCopyInput, CanvasEditResult, CanvasPasteInput, CanvasTarget} from '../../contracts/src/canvas-editing.ts';
import {canvasCopyNodeFields, canvasCopyPositionSchema, canvasCopyPrevisFields, canvasCopyShotFields} from '../../contracts/src/canvas-copy-fields.ts';
import type {CanvasCopyNodeFields, CanvasCopyShotFields} from '../../contracts/src/canvas-copy-fields.ts';
import {CANVAS_GRID, canvasBoxesSeparated} from '../../contracts/src/canvas-position.ts';
import type {CanvasBox, CanvasPosition} from '../../contracts/src/canvas-position.ts';
import {AppError} from '../../contracts/src/app-error.ts';
import {isProjectId} from '../../contracts/src/project-file.ts';
import {activeShotPositions, canvasError, canvasLimit, canvasTables, expectCanvasRows} from './canvas-patch.ts';
import type {CanvasPatch, CanvasRow} from './canvas-patch.ts';
import {createOwnedMediaGraphReader} from './inspection.ts';
import {INSPECTION_ROW_LIMITS} from './inspection-query.ts';
import type {ProjectStore} from './project-file/store.ts';

const SNAPSHOT_COUNT = 16;
const POSITION_STEP = 24;
const MAX_PLACEMENT_PROBES = 4096;
const MAX_BOX_CHECKS = 8_000_000;
// Covers the maximum current shot, media, text and previs card sizes across
// workbench UI densities. Keep obstacle admission independent of renderer data.
const cardSize = {width: 260, height: 264};
type Card = {id: string; kind: 'shot'; fields: CanvasCopyShotFields} | {id: string; kind: 'node'; fields: CanvasCopyNodeFields};
type Link = {source: string; target: string; kind: 'decorative'} |
  {source: string; target: string; kind: 'reference'; role: 'first_frame'; sourceAssetId: string};
interface Snapshot {readonly cards: readonly Card[]; readonly links: readonly Link[]}
interface SavedSnapshot {
  readonly documentId: string;
  readonly projectId: string;
  readonly owner: string;
  readonly expiresAt: number;
  readonly snapshot: Snapshot;
  readonly expiration: ReturnType<typeof setTimeout>;
}
const snapshots = new WeakMap<object, Map<string, SavedSnapshot>>();

function unavailable(): never {
  throw new AppError('CANVAS_CLIPBOARD_UNAVAILABLE', '只能粘贴在此画板复制且未过期的元素。', 409);
}
function noSpace(): never {
  throw new AppError('CANVAS_PASTE_NO_SPACE', '当前画板视口没有足够空间放置这些元素。', 409);
}

function projectOwner(store: ProjectStore): string {
  // Only lstat the held project. Opening an extra file descriptor could
  // release SQLite's process-level locks when it closes.
  const info = lstatSync(store.projectFile, {bigint: true, throwIfNoEntry: false});
  if (!info?.isFile() || info.nlink !== 1n) return unavailable();
  return JSON.stringify([store.projectFile, String(info.dev), String(info.ino), String(info.birthtimeNs)]);
}

interface ClipAsset {readonly mimeType: string; readonly fullHash: boolean}
function assetReader(store: ProjectStore): (id: string) => ClipAsset | null {
  const cache = new Map<string, ClipAsset | null>();
  let graph: ReturnType<typeof createOwnedMediaGraphReader> | undefined;
  return id => {
    if (cache.has(id)) return cache.get(id)!;
    let asset: ClipAsset | null = null;
    try {
      const value = (graph ??= createOwnedMediaGraphReader(store.db, store.projectId)).asset(id);
      if (typeof value.mimeType === 'string') {
        asset = {mimeType: value.mimeType, fullHash: typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(value.sha256)};
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'INSPECTION_BUDGET_EXCEEDED') return canvasLimit();
      if (!(error instanceof AppError) || error.code !== 'INSPECTION_UNAVAILABLE') throw error;
    }
    cache.set(id, asset);
    return asset;
  };
}
const isImage = (asset: ClipAsset | null): boolean => Boolean(asset && ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType));
const isFirstFrameAsset = (asset: ClipAsset | null): boolean => isImage(asset) && asset!.fullHash;
const isNodeAsset = (asset: ClipAsset | null, type: string): boolean =>
  asset !== null && (type === 'text' || asset.mimeType.startsWith(`${type}/`));

function captureCards(store: ProjectStore, input: CanvasCopyInput, readAsset: ReturnType<typeof assetReader>): Card[] {
  const selected = expectCanvasRows(store, input.targets, false).filter(row => row.kind !== 'edge');
  if (!selected.length) throw new AppError('CANVAS_CLIPBOARD_NO_CARDS', '只选了连线，无法复制。', 409);
  if (new Set(selected.map(row => row.id)).size !== selected.length) return canvasError('duplicate-target');
  const shots = selected.filter(row => row.kind === 'shot');
  if (shots.length) {
    const order = new Map(activeShotPositions(store).map(({id}, index) => [id, index]));
    shots.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }
  const nodes = selected.filter(row => row.kind === 'node');
  function shotCard(row: CanvasRow): Card {
    const parsed = canvasCopyShotFields.safeParse({...row.data, parameters: row.data.parameters ?? {}});
    if (!parsed.success) return canvasError('clipboard-fields', {id: row.id});
    const fields = parsed.data;
    return {id: row.id, kind: 'shot', fields: {...fields,
      referenceAssetIds: fields.referenceAssetIds.filter(id => readAsset(id) !== null),
      ...(fields.lastFrameAssetId && !isImage(readAsset(fields.lastFrameAssetId)) ? {lastFrameAssetId: null} : {}),
    }};
  }
  function nodeCard(row: CanvasRow): Card {
    if (row.data.type === 'previs') {
      const parsed = canvasCopyPrevisFields.safeParse(row.data);
      if (!parsed.success) return canvasError('clipboard-fields', {id: row.id});
      const fields = parsed.data;
      return {id: row.id, kind: 'node', fields: {...fields, scene: {...fields.scene,
        keyframes: fields.scene.keyframes.map(frame => ({...frame, exports: []})),
      }}};
    }
    const parsed = canvasCopyNodeFields.safeParse({label: '', text: '', ...row.data});
    if (!parsed.success) return canvasError('clipboard-fields', {id: row.id});
    const fields = parsed.data;
    if (fields.type === 'text') {
      if (fields.assetId && !isNodeAsset(readAsset(fields.assetId), fields.type)) delete fields.assetId;
    } else if (!fields.assetId || !isNodeAsset(readAsset(fields.assetId), fields.type)) {
      return canvasError('clipboard-reference', {id: row.id});
    }
    return {id: row.id, kind: 'node', fields};
  }
  return [...shots.map(shotCard), ...nodes.map(nodeCard)];
}

function captureLinks(store: ProjectStore, cards: readonly Card[], readAsset: ReturnType<typeof assetReader>): Link[] {
  const byId = new Map(cards.map(card => [card.id, card]));
  const selected = JSON.stringify([...byId.keys()]);
  // Complete the first-frame slot even when another source is unselected.
  // Invalid or ambiguous slots must become manual references on the copy.
  const rows = store.db.prepare(`WITH selected AS (SELECT value AS id FROM json_each(?)), edges AS (
    SELECT id, CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.edges}
      AND json_valid(data) THEN data END AS data
    FROM project.edges WHERE projectId=? AND archivedAt IS NULL
  ), decoded AS (SELECT id, json_extract(data,'$.id') IS id AND json_extract(data,'$.projectId') IS ? AS owned,
    json_extract(data,'$.source') AS source, json_extract(data,'$.target') AS target,
    json_extract(data,'$.kind') AS kind, json_extract(data,'$.role') AS role, json_extract(data,'$.sourceAssetId') AS assetId
    FROM edges
  ) SELECT * FROM decoded WHERE target IN (SELECT id FROM selected) AND (kind='reference' OR source IN (SELECT id FROM selected))
    ORDER BY id LIMIT ?`).all(selected, store.projectId, store.projectId, CANVAS_EDIT_LIMITS.effects + 1);
  if (rows.length > CANVAS_EDIT_LIMITS.effects) return canvasLimit();
  const referenceSlots = new Map<string, number>();
  for (const row of rows) if (row.kind === 'reference' && typeof row.target === 'string') {
    referenceSlots.set(row.target, (referenceSlots.get(row.target) ?? 0) + 1);
  }
  const links: Link[] = [], decoration = new Set<string>();
  for (const row of rows) {
    if (row.owned !== 1 || !isProjectId(row.id) || !isProjectId(row.source) || !isProjectId(row.target)) continue;
    const source = byId.get(row.source), target = byId.get(row.target);
    if (!source || !target || source.id === target.id) continue;
    if (row.kind === 'reference') {
      const refs = target.kind === 'shot' ? target.fields.referenceAssetIds : [];
      if (source.kind === 'node' && source.fields.type === 'image' && row.role === 'first_frame' &&
          isProjectId(row.assetId) && source.fields.assetId === row.assetId && refs.length === 1 && refs[0] === row.assetId &&
          referenceSlots.get(target.id) === 1 && isFirstFrameAsset(readAsset(row.assetId))) {
        links.push({source: source.id, target: target.id, kind: 'reference', role: 'first_frame', sourceAssetId: row.assetId});
      }
    } else if (row.kind === 'decorative' || row.kind === null) {
      const key = `${source.id}:${target.id}`;
      if (!decoration.has(key)) {
        decoration.add(key);
        links.push({source: source.id, target: target.id, kind: 'decorative'});
      }
    }
    if (links.length > CANVAS_CLIPBOARD_LIMITS.links) return canvasLimit();
  }
  return links;
}

function validateReferences(store: ProjectStore, snapshot: Snapshot): void {
  const readAsset = assetReader(store);
  for (const card of snapshot.cards) {
    const {fields, id} = card;
    if (card.kind === 'shot') {
      const fields = card.fields;
      if (fields.referenceAssetIds.some(asset => readAsset(asset) === null) ||
          fields.lastFrameAssetId && !isImage(readAsset(fields.lastFrameAssetId))) canvasError('clipboard-reference', {id});
    } else if ('assetId' in fields && fields.assetId && !isNodeAsset(readAsset(fields.assetId), fields.type)) {
      canvasError('clipboard-reference', {id});
    }
  }
  for (const link of snapshot.links) {
    if (link.kind === 'reference' && !isFirstFrameAsset(readAsset(link.sourceAssetId))) canvasError('clipboard-reference');
  }
}

function openPositions(store: ProjectStore): CanvasBox[] {
  const rows = store.db.prepare(`WITH live AS (
    SELECT id, CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.shots} AND json_valid(data)
      THEN data END AS data FROM project.shots WHERE projectId=? AND archivedAt IS NULL
    UNION ALL SELECT id, CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.nodes} AND json_valid(data)
      THEN data END AS data FROM project.nodes WHERE projectId=? AND archivedAt IS NULL
  ) SELECT id, json_extract(data,'$.id') IS id AND json_extract(data,'$.projectId') IS ? AS owned,
    json_extract(data,'$.position') AS position FROM live LIMIT ?`)
    .all(store.projectId, store.projectId, store.projectId, CANVAS_EDIT_LIMITS.targets + 1);
  if (rows.length > CANVAS_EDIT_LIMITS.targets) return canvasLimit();
  return rows.map(row => {
    if (row.owned !== 1 || typeof row.position !== 'string') return canvasError('invalid-position');
    const point = canvasCopyPositionSchema.safeParse(JSON.parse(row.position));
    if (!point.success) return canvasError('invalid-position');
    return {...point.data, ...cardSize};
  });
}

function findPlacement(cards: readonly Card[], fixed: readonly CanvasBox[], viewport: CanvasBox): CanvasPosition {
  const points = cards.map(card => card.fields.position);
  const minimum = {x: Math.min(...points.map(point => point.x)), y: Math.min(...points.map(point => point.y))};
  const width = Math.max(...points.map(point => point.x)) - minimum.x + cardSize.width;
  const height = Math.max(...points.map(point => point.y)) - minimum.y + cardSize.height;
  const last = {x: viewport.x + viewport.width - width, y: viewport.y + viewport.height - height};
  if (last.x < viewport.x || last.y < viewport.y) return noSpace();
  const initial = {x: Math.min(Math.max(viewport.x, minimum.x + POSITION_STEP), last.x),
    y: Math.min(Math.max(viewport.y, minimum.y + POSITION_STEP), last.y)};
  const obstacles = fixed.filter(box => !canvasBoxesSeparated(viewport, box, CANVAS_GRID.gap));
  const tried = new Set<string>();
  let checks = 0;
  function clear(x: number, y: number): boolean {
    if (x < viewport.x || y < viewport.y || x > last.x || y > last.y) return false;
    const key = `${x}:${y}`;
    if (tried.has(key)) return false;
    tried.add(key);
    if (tried.size > MAX_PLACEMENT_PROBES) return noSpace();
    const group = {x, y, width, height};
    for (const obstacle of obstacles) {
      if (++checks > MAX_BOX_CHECKS) return noSpace();
      if (canvasBoxesSeparated(group, obstacle, CANVAS_GRID.gap)) continue;
      for (const point of points) {
        if (++checks > MAX_BOX_CHECKS) return noSpace();
        if (!canvasBoxesSeparated({x: x + point.x - minimum.x, y: y + point.y - minimum.y, ...cardSize}, obstacle, CANVAS_GRID.gap)) return false;
      }
    }
    return true;
  }
  const offset = (x: number, y: number) => ({x: x - minimum.x, y: y - minimum.y});
  if (clear(initial.x, initial.y)) return offset(initial.x, initial.y);
  // First stay close to the original group. If it was off-screen or the
  // surrounding area is full, continue from the viewport's top-left.
  for (let ring = 1; ring <= 12; ring++) {
    for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
      if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
      const x = initial.x + dx * POSITION_STEP, y = initial.y + dy * POSITION_STEP;
      if (clear(x, y)) return offset(x, y);
    }
  }
  for (let y = viewport.y; ; y = Math.min(last.y, y + POSITION_STEP)) {
    for (let x = viewport.x; ; x = Math.min(last.x, x + POSITION_STEP)) {
      if (clear(x, y)) return offset(x, y);
      if (x >= last.x) break;
    }
    if (y >= last.y) break;
  }
  return noSpace();
}

export function createCanvasClipboard(store: ProjectStore, owner: object, time: () => number) {
  let entries = snapshots.get(owner);
  if (!entries) {
    entries = new Map<string, SavedSnapshot>();
    snapshots.set(owner, entries);
  }
  const cache = entries;
  const remove = (id: string): void => {
    const entry = cache.get(id);
    if (entry) clearTimeout(entry.expiration);
    cache.delete(id);
  };

  function copy(input: CanvasCopyInput) {
    const alreadyReading = store.db.isTransaction;
    if (!alreadyReading) store.db.exec('BEGIN DEFERRED');
    let snapshot: Snapshot, identity: string;
    try {
      const readAsset = assetReader(store), cards = captureCards(store, input, readAsset);
      snapshot = {cards, links: captureLinks(store, cards, readAsset)};
      if (Buffer.byteLength(JSON.stringify(snapshot)) > CANVAS_CLIPBOARD_LIMITS.snapshotBytes) return canvasLimit();
      identity = projectOwner(store);
    } finally {
      if (!alreadyReading) store.db.exec('COMMIT');
    }
    const clock = time(), snapshotId = randomUUID();
    for (const [id, entry] of cache) if (entry.expiresAt <= clock) remove(id);
    if (cache.size >= SNAPSHOT_COUNT) remove(cache.keys().next().value!);
    const expiration = setTimeout(() => cache.delete(snapshotId), CANVAS_CLIPBOARD_LIMITS.lifetimeMs).unref();
    cache.set(snapshotId, {projectId: store.projectId, documentId: input.documentId,
      owner: identity, expiresAt: clock + CANVAS_CLIPBOARD_LIMITS.lifetimeMs, snapshot, expiration});
    return {projectId: store.projectId, documentId: input.documentId, snapshotId, count: snapshot.cards.length};
  }

  function paste(input: Pick<CanvasPasteInput, 'projectId' | 'documentId' | 'snapshotId' | 'viewport'>, at: string) {
    if (!store.db.isTransaction) throw new TypeError('Canvas paste requires the project transaction');
    const entry = cache.get(input.snapshotId);
    if (!entry || entry.expiresAt <= time() || entry.documentId !== input.documentId || entry.projectId !== store.projectId ||
        entry.owner !== projectOwner(store)) return unavailable();
    const {snapshot} = entry;
    validateReferences(store, snapshot);
    const offset = findPlacement(snapshot.cards, openPositions(store), input.viewport);
    const shotOrder = snapshot.cards.some(card => card.kind === 'shot') ? activeShotPositions(store) : null;
    const beforeOrder = shotOrder?.map(shot => shot.id) ?? null;
    const afterOrder = shotOrder?.map(shot => shot.id) ?? null;
    let orderIndex = (shotOrder?.at(-1)?.position ?? -1) + 1;
    const archived = {at, batchId: randomUUID(), reason: 'undo-create' as const};
    const mapped = new Map<string, string>();
    const created: NonNullable<CanvasEditResult['created']> = [];
    const rows: CanvasPatch['rows'][number][] = [];
    function insert(kind: 'shot' | 'node' | 'edge', data: {id: string} & Record<string, unknown>): void {
      const {id} = data;
      store.db.prepare(`INSERT INTO project.${canvasTables[kind]}(id,projectId,data,archivedAt,archiveBatchId,archiveReason)
        VALUES(?,?,?,?,?,?)`).run(id, store.projectId, JSON.stringify(data), archived.at, archived.batchId, archived.reason);
      rows.push({kind, id, fields: {archive: archived}});
    }
    for (const card of snapshot.cards) {
      const id = randomUUID(), {kind} = card;
      const point = {x: card.fields.position.x + offset.x, y: card.fields.position.y + offset.y};
      if (!canvasCopyPositionSchema.safeParse(point).success) return noSpace();
      const base = {...card.fields, id, projectId: store.projectId, position: point, revision: 1, createdAt: at};
      if (kind === 'shot') {
        if (!Number.isSafeInteger(orderIndex) || !afterOrder || afterOrder.length >= CANVAS_EDIT_LIMITS.effects) return canvasLimit();
        insert(kind, {...base, orderIndex: orderIndex++, selectedVersionId: null, updatedAt: at});
        afterOrder.push(id);
      } else insert(kind, {...base, ...(card.fields.type === 'previs' ? {sceneRevision: 1} : {})});
      mapped.set(card.id, id);
      created.push({kind, id});
    }
    for (const link of snapshot.links) {
      insert('edge', {...link, id: randomUUID(), projectId: store.projectId,
        source: mapped.get(link.source)!, target: mapped.get(link.target)!, createdAt: at});
    }
    const common = {version: 1 as const, anchors: [], guards: rows.map(({kind,id}) => ({kind,id}))};
    const before = {...common, rows, order: beforeOrder};
    const after = {...common, rows: rows.map(row => ({...row, fields: {archive: null}})), order: afterOrder};
    return {before, after, created};
  }

  return {copy, paste};
}

export function canvasPasteBindingEvidence(store: ProjectStore, targets: readonly CanvasTarget[]): readonly unknown[] {
  const shots = targets.filter(target => target.kind === 'shot').map(target => target.id);
  if (!shots.length) return [];
  const rows = store.db.prepare(`SELECT id,shotId,subjectId,role,revision,subjectVersionId,reviewedHeadVersionId
    FROM project.subject_bindings WHERE projectId=? AND shotId IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT ?`)
    .all(store.projectId, JSON.stringify(shots), CANVAS_EDIT_LIMITS.effects + 1);
  if (rows.length > CANVAS_EDIT_LIMITS.effects) return canvasLimit();
  return rows;
}

/** Read-only resolver for a same-owner, unexpired canvas copy. The unified
 * format-5 board paste uses the captured cards (never links: sequence and
 * reference edges are owned by the chain/RI intents) to create detached copies
 * in its own transaction. */
export function readCanvasClipboardSnapshot(store: ProjectStore, owner: object,
  input: Pick<CanvasPasteInput, 'projectId' | 'documentId' | 'snapshotId'>): {readonly cards: Snapshot['cards'];
    readonly links: Snapshot['links']} | null {
  const entry = snapshots.get(owner)?.get(input.snapshotId);
  if (!entry || entry.expiresAt <= Date.now() || entry.documentId !== input.documentId ||
      entry.projectId !== store.projectId || entry.owner !== projectOwner(store)) return null;
  return {cards: entry.snapshot.cards, links: entry.snapshot.links};
}
