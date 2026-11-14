import {createHash} from 'node:crypto';
import {AppError} from '../../contracts/src/app-error.ts';
import {CANVAS_EDIT_LIMITS} from '../../contracts/src/canvas-editing.ts';
import type {CanvasTarget, CanvasTargetExpectation} from '../../contracts/src/canvas-editing.ts';
import {CANVAS_GRID} from '../../contracts/src/canvas-position.ts';
import {MIO_CANVAS_SELECTION_LIMIT} from '../../contracts/src/mio-canvas.ts';
import {layoutCanvas} from '../../contracts/src/canvas-tidy-layout.ts';
import {isProjectId} from '../../contracts/src/project-file.ts';
import {readMioTargetRevision} from './agent/mio-target-revisions.ts';
import {canvasActiveEdgeCondition, hasCanvasArchives} from './canvas-active.ts';
import {assertCanvasEdgeEffects, canvasEdgeEvidence, planCanvasArchive} from './canvas-archive.ts';
import {inspectCanvasDependencies} from './canvas-dependencies.ts';
import type {MioCanvasRequester} from './canvas-dependencies.ts';
import {assertCanvasUnblocked, planCanvasMoves} from './canvas-editing.ts';
import {
  activeShotPositions, applyCanvasPatch, canvasError, canvasKey, canvasLimit, compareCanvasTargets,
  decodeCanvasPatch, encodeCanvasPatch, expectCanvasPatchBase, expectCanvasRows, previousFields, readCanvasRow,
} from './canvas-patch.ts';
import type {CanvasPatch} from './canvas-patch.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import type {ProjectStore} from './project-file/store.ts';
import {assertProjectStore} from './store-runtime.ts';

export type {MioCanvasRequester} from './canvas-dependencies.ts';

export type MioCanvasEditInput =
  | {readonly operation: 'layout'; readonly targets?: readonly CanvasTarget[]}
  | {readonly operation: 'archive' | 'restore'; readonly targets: readonly CanvasTarget[]};

export interface MioCanvasPreparation {
  readonly input: MioCanvasEditInput;
  readonly proof: string;
  readonly targets: CanvasTargetExpectation[];
  readonly impact: {
    readonly shots: {id: string; title: string}[];
    readonly shotImpacts: {id: string; number: number | null; versions: number; clips: number; usedVersions: number}[];
    readonly versions: number;
    readonly clips: number;
  };
  readonly affected: number;
}

export type MioCanvasUndo = {readonly before: string; readonly after: string};

type ProposedPatch = Omit<CanvasPatch, 'dependencyDigest'>;

const MAX_MIO_CANVAS_TARGETS = 1000;
const MAX_MIO_CANVAS_UNDO_BYTES = 100 * 1024;
const cardSize = {width: CANVAS_GRID.columnWidth - CANVAS_GRID.gap, height: CANVAS_GRID.rowHeight - CANVAS_GRID.gap};
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function assertFormat4(store: ProjectStore): void {
  assertProjectStore(store);
  if (!hasCanvasArchives(store.db)) throw new AppError('UNKNOWN_OPERATION', '未知操作', 404);
}

function inReadTransaction<T>(store: ProjectStore, read: () => T): T {
  assertProjectStore(store);
  if (store.db.isTransaction) return read();
  store.db.exec('BEGIN');
  try {
    const value = read();
    store.db.exec('COMMIT');
    return value;
  } catch (error) {
    if (store.db.isTransaction) store.db.exec('ROLLBACK');
    throw error;
  }
}

function targetLedger(store: ProjectStore, targets: readonly CanvasTarget[]): CanvasTargetExpectation[] {
  return targets.map(({kind, id}) => ({
    kind, id, revision: readMioTargetRevision(store.db, store.projectId, kind, id) ?? canvasError('missing', {kind, id}),
  }));
}

function patchTargets(patch: ProposedPatch): CanvasTarget[] {
  const targets = new Map<string, CanvasTarget>();
  for (const {kind, id} of [...patch.guards, ...patch.rows]) targets.set(canvasKey({kind, id}), {kind, id});
  if (targets.size > MAX_MIO_CANVAS_TARGETS) return canvasLimit();
  return [...targets.values()].sort(compareCanvasTargets);
}

function patchEvidence(store: ProjectStore, patch: ProposedPatch, targets: readonly CanvasTarget[], requester?: MioCanvasRequester) {
  if (!targets.length) return digest([[], []]);
  const effect = inspectCanvasDependencies(store, targets, [], {requester});
  assertCanvasUnblocked(effect);
  return digest([effect.digest, canvasEdgeEvidence(store, patch)]);
}

function canvasLayout(store: ProjectStore, selection: readonly CanvasTargetExpectation[] | undefined) {
  const {db, projectId} = store;
  if (selection?.some(target => target.kind === 'edge')) return canvasError('layout-target');
  if (selection) expectCanvasRows(store, selection, false);
  const shots = activeShotPositions(store);
  const nodes = db.prepare('SELECT id FROM project.nodes WHERE projectId=? AND archivedAt IS NULL ORDER BY id LIMIT ?')
    .all(projectId, CANVAS_EDIT_LIMITS.targets + 1);
  if (shots.length + nodes.length > CANVAS_EDIT_LIMITS.targets ||
      !selection && shots.length + nodes.length > MAX_MIO_CANVAS_TARGETS) return canvasLimit();

  const shotCards = shots.map(({id, position: orderIndex}) => {
    const row = readCanvasRow(store, {id, kind: 'shot'});
    const position = previousFields(row, {position: null}).position ?? canvasError('invalid-position', {id});
    return {id, position, orderIndex, ...cardSize};
  });
  const nodeCards = nodes.map(({id}) => {
    if (!isProjectId(id)) return canvasError('invalid-record');
    const row = readCanvasRow(store, {id, kind: 'node'});
    const position = previousFields(row, {position: null}).position ?? canvasError('invalid-position', {id});
    if (typeof row.data.type !== 'string') return canvasError('invalid-record', {id});
    return {id, position, type: row.data.type, ...cardSize};
  });
  const edges = db.prepare(`SELECT id FROM project.edges record WHERE projectId=? AND ${canvasActiveEdgeCondition(db, 'record')}
    ORDER BY id LIMIT ?`).all(projectId, CANVAS_EDIT_LIMITS.effects + 1);
  if (edges.length > CANVAS_EDIT_LIMITS.effects) return canvasLimit();
  const links = edges.map(({id}) => {
    if (!isProjectId(id)) return canvasError('invalid-edge');
    const {data: {source, target, kind, role}} = readCanvasRow(store, {id, kind: 'edge'});
    if (!isProjectId(source) || !isProjectId(target) || kind !== undefined && kind !== 'decorative' && kind !== 'reference' ||
        kind === 'reference' && role !== 'first_frame') return canvasError('invalid-edge', {id});
    return {source, target, kind, role: kind === 'reference' ? 'first_frame' : undefined};
  });
  const guards = selection?.map(({id, kind}) => ({id, kind})) ?? [
    ...shotCards.map(({id}) => ({id, kind: 'shot' as const})),
    ...nodeCards.map(({id}) => ({id, kind: 'node' as const})),
  ].sort(compareCanvasTargets);
  const selectedIds = selection && new Set(selection.map(({id}) => id));
  const layout = layoutCanvas({shots: shotCards, nodes: nodeCards, edges: links, selectedIds});
  if (layout.status === 'no-fit') return canvasError('layout-no-fit');
  const ledger = new Map(targetLedger(store, guards).map(target => [canvasKey(target), target]));
  const plan = planCanvasMoves(store, layout.moves.map(move => ({
    ...move, revision: ledger.get(canvasKey(move))?.revision ?? canvasError('layout-target', {id: move.id}),
  })));
  return {before: {...plan.before, guards}, after: {...plan.after, guards}, selected: []};
}

function requireUserArchive(plan: ReturnType<typeof planCanvasArchive>): void {
  const unknown = plan.selected.find(row => row.archive?.reason !== 'user-delete');
  if (unknown) canvasError('not-user-archived', {kind: unknown.kind, id: unknown.id});
}

function checkUndoSize(undo: MioCanvasUndo): void {
  if (Buffer.byteLength(JSON.stringify(undo)) > MAX_MIO_CANVAS_UNDO_BYTES) canvasLimit();
}

function preparePlan(store: ProjectStore, input: MioCanvasEditInput, at: string, requester?: MioCanvasRequester) {
  assertFormat4(store);
  const {operation, targets: selection} = input;
  if (selection && (!selection.length || selection.length > MIO_CANVAS_SELECTION_LIMIT)) return canvasLimit();
  if (selection?.some(({kind, id}) => !isProjectId(id) || kind !== 'shot' && kind !== 'node' && kind !== 'edge')) {
    return canvasError('invalid-target');
  }
  const explicit = selection && targetLedger(store, [...selection].sort(compareCanvasTargets));
  const plan = operation === 'layout' ? canvasLayout(store, explicit)
    : planCanvasArchive(store, operation, explicit ?? canvasError('missing-target'), at);
  if (operation === 'restore') requireUserArchive(plan);
  const closure = patchTargets(plan.before);
  const targets = targetLedger(store, closure);
  const selectedShots = plan.selected.filter(row => row.kind === 'shot');
  const impact = selectedShots.length ? inspectCanvasDependencies(store, closure, selectedShots, {reportShotImpacts: true, requester}) : null;
  if (impact) assertCanvasUnblocked(impact);
  const {versions, clips} = impact ?? {versions: 0, clips: 0};
  // The in-progress archive plan carries the exact active storyboard order.
  const storyNumbers = new Map((plan.before.order ?? []).map((id, index) => [id, index + 1]));
  const shots = [...selectedShots].sort((a, b) => (storyNumbers.get(a.id) ?? Infinity) - (storyNumbers.get(b.id) ?? Infinity)
    || compareCanvasTargets(a, b)).map(({id, data}) => ({
    id, title: typeof data.title === 'string' ? [...data.title.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()].slice(0, 80).join('') : '',
  }));
  const shotImpacts = shots.map(({id}) => ({
    id, number: storyNumbers.get(id) ?? null, ...(impact?.shotImpacts.get(id) ?? {versions: 0, clips: 0, usedVersions: 0}),
  }));
  const dependencyDigest = patchEvidence(store, plan.before, closure, requester);
  const before: CanvasPatch = {...plan.before, dependencyDigest};
  const after: CanvasPatch = {...plan.after, dependencyDigest};
  const affected = after.rows.length;
  if (affected) checkUndoSize({before: encodeCanvasPatch(before), after: encodeCanvasPatch(after)});
  const preparation: MioCanvasPreparation = {
    input, targets, impact: {shots, shotImpacts, versions, clips}, affected,
    proof: digest([store.projectId, operation, explicit ?? null, readProjectContentStamp(store.db), targets,
      impact?.digest ?? null, dependencyDigest, operation === 'layout' ? after.rows : after.rows.map(({kind, id}) => ({kind, id}))]),
  };
  return {before, after, preparation, closure};
}

/** Freeze live target revisions and dependencies for this narrow Mio effect. */
export function prepareMioCanvasEdit(store: ProjectStore, input: MioCanvasEditInput, requester?: MioCanvasRequester): MioCanvasPreparation {
  return inReadTransaction(store, () => preparePlan(store, input, new Date().toISOString(), requester).preparation);
}

/** The caller commits the patch and Mio change receipt in the same transaction. */
export function applyMioCanvasEdit(store: ProjectStore, prepared: MioCanvasPreparation, requester?: MioCanvasRequester) {
  if (!store.db.isTransaction) throw new TypeError('Mio canvas edit requires the project transaction');
  const at = new Date().toISOString();
  const {before, after, preparation, closure} = preparePlan(store, prepared.input, at, requester);
  if (preparation.proof !== prepared.proof) throw new AppError('AGENT_TASK_TARGET_CHANGED', '画布内容或关联已变化，请重新读取。', 409);
  const changedRows: CanvasTarget[] = after.rows.map(({kind, id}) => ({kind, id}));
  if (!preparation.affected) return {affected: 0, targets: preparation.targets, changedRows, undo: null};
  applyCanvasPatch(store, before, after, at);
  const undo: MioCanvasUndo = {
    before: encodeCanvasPatch(before),
    after: encodeCanvasPatch({...after, dependencyDigest: patchEvidence(store, after, closure, requester)}),
  };
  checkUndoSize(undo);
  return {affected: preparation.affected, targets: targetLedger(store, closure), changedRows, undo};
}

/** Decode the durable asset-free patch and require every guard and written
 * identity in the journal. Asset references remain in the owned content rows. */
export function readMioCanvasUndo(value: unknown, expected: readonly {readonly kind: string; readonly id: string}[]) {
  if (!value || typeof value !== 'object' || !('before' in value) || !('after' in value) || Object.keys(value).length !== 2 ||
      typeof value.before !== 'string' || typeof value.after !== 'string') return canvasError('invalid-mio-canvas-undo');
  checkUndoSize({before: value.before, after: value.after});
  const before = decodeCanvasPatch(value.before), after = decodeCanvasPatch(value.after);
  const closure = patchTargets(before);
  const expectedKeys = new Set(expected.map(({kind, id}) => `${kind}:${id}`));
  if (JSON.stringify(before.guards) !== JSON.stringify(after.guards) || before.rows.length !== after.rows.length ||
      before.rows.some((row, index) => {
        const other = after.rows[index]!;
        return canvasKey(row) !== canvasKey(other) || Object.keys(row.fields).sort().join() !== Object.keys(other.fields).sort().join();
      }) ||
      expected.length !== closure.length ||
      !closure.every(target => expectedKeys.has(canvasKey(target)))) {
    return canvasError('invalid-mio-canvas-undo');
  }
  return {before, after, closure};
}

function inversePlan(store: ProjectStore, value: unknown, expected: readonly CanvasTargetExpectation[], requester?: MioCanvasRequester) {
  assertFormat4(store);
  const {before: after, after: before, closure} = readMioCanvasUndo(value, expected);
  const current = targetLedger(store, closure);
  if ([...expected].sort(compareCanvasTargets).some((target, index) => target.revision !== current[index]!.revision)) {
    return canvasError('mio-canvas-revision');
  }
  expectCanvasPatchBase(store, before, after);
  if (patchEvidence(store, before, closure, requester) !== before.dependencyDigest) return canvasError('mio-canvas-dependencies');
  assertCanvasEdgeEffects(store, after);
  return {before, after, closure};
}

export function validateMioCanvasUndo(store: ProjectStore, undo: unknown, expected: readonly CanvasTargetExpectation[],
  requester?: MioCanvasRequester): void {
  inReadTransaction(store, () => inversePlan(store, undo, expected, requester));
}

export function undoMioCanvasEdit(store: ProjectStore, undo: unknown, expected: readonly CanvasTargetExpectation[],
  requester?: MioCanvasRequester): CanvasTargetExpectation[] {
  if (!store.db.isTransaction) throw new TypeError('Mio canvas undo requires the project transaction');
  const {before, after, closure} = inversePlan(store, undo, expected, requester);
  applyCanvasPatch(store, before, after, new Date().toISOString());
  return targetLedger(store, closure);
}
