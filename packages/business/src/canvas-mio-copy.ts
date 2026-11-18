import {createHash, randomUUID} from 'node:crypto';
import {AppError} from '../../contracts/src/app-error.ts';
import {CANVAS_CLIPBOARD_LIMITS, CANVAS_EDIT_LIMITS} from '../../contracts/src/canvas-editing.ts';
import type {CanvasTarget, CanvasTargetExpectation} from '../../contracts/src/canvas-editing.ts';
import {mioCanvasCopySchemas} from '../../contracts/src/mio-canvas-copy.ts';
import type {MioCanvasCopyInput, MioCanvasCopyOperation} from '../../contracts/src/mio-canvas-copy.ts';
import {readMioTargetRevision} from './agent/mio-target-revisions.ts';
import {hasCanvasArchives} from './canvas-active.ts';
import {assertCanvasEdgeEffects, canvasEdgeEvidence} from './canvas-archive.ts';
import {canvasPasteBindingEvidence, createCanvasClipboard} from './canvas-clipboard.ts';
import {inspectCanvasDependencies} from './canvas-dependencies.ts';
import type {MioCanvasRequester} from './canvas-dependencies.ts';
import {assertCanvasUnblocked} from './canvas-editing.ts';
import {undoMioCanvasEdit, validateMioCanvasUndo} from './canvas-mio-editing.ts';
import {applyCanvasPatch, canvasError, canvasKey, canvasLimit, compareCanvasTargets, encodeCanvasPatch, readCanvasRow} from './canvas-patch.ts';
import type {CanvasPatch} from './canvas-patch.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import {INSPECTION_ROW_LIMITS} from './inspection-query.ts';
import type {ProjectStore} from './project-file/store.ts';
import {assertProjectStore} from './store-runtime.ts';

export interface MioCanvasCopyPreparation {
  readonly operation: MioCanvasCopyOperation;
  readonly input: MioCanvasCopyInput['input'];
  readonly targets: CanvasTargetExpectation[];
  readonly proof: string;
}
export interface MioCanvasCopyUndo {
  readonly before: string;
  readonly after: string;
  readonly bindingDigest: string;
}
interface ClipboardHandle {
  readonly snapshotId: string;
  readonly count: number;
  readonly targets: readonly CanvasTarget[];
  readonly expiresAt: number;
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_UNDO_BYTES = 100 * 1024;
const unavailable = (): never => {throw new AppError('CANVAS_CLIPBOARD_UNAVAILABLE', '只能粘贴在此画板复制且未过期的元素。', 409);};

function assertFormat4(store: ProjectStore): void {
  assertProjectStore(store);
  if (!hasCanvasArchives(store.db)) throw new AppError('UNKNOWN_OPERATION', '未知操作', 404);
}
function readTransaction<T>(store: ProjectStore, read: () => T): T {
  if (store.db.isTransaction) return read();
  store.db.exec('BEGIN');
  try {const result = read(); store.db.exec('COMMIT'); return result;}
  catch (error) {if (store.db.isTransaction) store.db.exec('ROLLBACK'); throw error;}
}
function targetLedger(store: ProjectStore, targets: readonly CanvasTarget[], beforeTargetRead?: (target: CanvasTarget) => void): CanvasTargetExpectation[] {
  return [...targets].sort(compareCanvasTargets).map(target => {
    beforeTargetRead?.(target);
    readCanvasRow(store, target);
    return {...target, revision: readMioTargetRevision(store.db, store.projectId, target.kind, target.id) ?? canvasError('missing', target)};
  });
}
function copyReadTargets(store: ProjectStore, selected: readonly CanvasTarget[]): CanvasTarget[] {
  const cards = JSON.stringify(selected.filter(target => target.kind !== 'edge').map(target => target.id));
  // Snapshot admission also reads inbound reference slots when deciding whether
  // a first-frame link is unambiguous, including unselected source cards.
  const edges = store.db.prepare(`WITH selected AS (SELECT value AS id FROM json_each(?)), edges AS (
    SELECT id, CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.edges}
      AND json_valid(data) THEN data END AS data FROM project.edges WHERE projectId=? AND archivedAt IS NULL
  ) SELECT id FROM edges WHERE json_extract(data,'$.target') IN (SELECT id FROM selected)
    AND (json_extract(data,'$.kind')='reference' OR json_extract(data,'$.source') IN (SELECT id FROM selected))
    ORDER BY id LIMIT ?`).all(cards, store.projectId, CANVAS_EDIT_LIMITS.effects + 1);
  if (edges.length > CANVAS_EDIT_LIMITS.effects) return canvasLimit();
  const targets = new Map(selected.map(target => [canvasKey(target), target]));
  for (const edge of edges) {
    if (typeof edge.id !== 'string') return canvasError('invalid-record');
    const target = {kind: 'edge' as const, id: edge.id};
    targets.set(canvasKey(target), target);
  }
  return [...targets.values()];
}
function patchEvidence(store: ProjectStore, patch: CanvasPatch, requester?: MioCanvasRequester): string {
  const dependencies = inspectCanvasDependencies(store, patch.guards, [], {requester});
  assertCanvasUnblocked(dependencies);
  return digest([dependencies.digest, canvasEdgeEvidence(store, patch)]);
}
function undoEvidence(value: unknown): MioCanvasCopyUndo {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 ||
      !('before' in value) || typeof value.before !== 'string' || !('after' in value) || typeof value.after !== 'string' ||
      !('bindingDigest' in value) || typeof value.bindingDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.bindingDigest)) {
    return canvasError('invalid-mio-copy-undo');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_UNDO_BYTES) return canvasLimit();
  return {before: value.before, after: value.after, bindingDigest: value.bindingDigest};
}

/** One host document owns snapshots. A reconstructed owner must request a new copy. */
export function createMioCanvasCopy(store: ProjectStore, {time = Date.now}: {time?: () => number} = {}) {
  const owner = {}, documentId = randomUUID(), clipboard = createCanvasClipboard(store, owner, time);
  const handles = new Map<string, ClipboardHandle>();
  let disposed = false;
  const check = (): void => {
    assertFormat4(store);
    if (disposed) unavailable();
  };
  const handle = (snapshotId: string): ClipboardHandle => {
    const saved = handles.get(snapshotId);
    if (!saved || saved.expiresAt <= time()) return unavailable();
    return saved;
  };
  function freeze(input: MioCanvasCopyInput, beforeTargetRead?: (target: CanvasTarget) => void): MioCanvasCopyPreparation {
    const selected = input.operation === 'canvas.paste' ? handle(input.input.snapshotId).targets : input.input.targets;
    const explicit = targetLedger(store, selected, beforeTargetRead), selectedKeys = new Set(selected.map(canvasKey));
    const implicit = copyReadTargets(store, selected).filter(target => !selectedKeys.has(canvasKey(target)));
    const targets = [...explicit, ...targetLedger(store, implicit, beforeTargetRead)].sort(compareCanvasTargets);
    return {operation: input.operation, input: input.input, targets,
      proof: digest([store.projectId, documentId, input, targets, readProjectContentStamp(store.db)])};
  }
  function prepare(operation: MioCanvasCopyOperation, input: unknown, beforeTargetRead?: (target: CanvasTarget) => void): MioCanvasCopyPreparation {
    check();
    const parsed = mioCanvasCopySchemas[operation].safeParse(input);
    if (!parsed.success) throw new AppError('VALIDATION_ERROR', '画布复制参数无效。', 400);
    return readTransaction(store, () => freeze({operation, input: parsed.data} as MioCanvasCopyInput, beforeTargetRead));
  }
  function copy(targets: readonly CanvasTarget[]) {
    const saved = clipboard.copy({projectId: store.projectId, documentId, targets: targetLedger(store, targets)});
    for (const [id, entry] of handles) if (entry.expiresAt <= time()) handles.delete(id);
    if (handles.size >= 16) handles.delete(handles.keys().next().value!);
    handles.set(saved.snapshotId, {...saved, targets: targets.map(({kind,id}) => ({kind,id})), expiresAt: time() + CANVAS_CLIPBOARD_LIMITS.lifetimeMs});
    return {snapshotId: saved.snapshotId, count: saved.count};
  }
  function apply(prepared: MioCanvasCopyPreparation, requester?: MioCanvasRequester) {
    check();
    if (!store.db.isTransaction) throw new TypeError('Mio canvas copy requires the project transaction');
    const current = prepare(prepared.operation, prepared.input);
    if (prepared.proof !== current.proof) throw new AppError('AGENT_TASK_TARGET_CHANGED', '画布内容或关联已变化，请重新读取。', 409);
    if (prepared.operation === 'canvas.copy.snapshot') {
      const input = prepared.input as Extract<MioCanvasCopyInput, {operation: 'canvas.copy.snapshot'}>['input'];
      return {result: copy(input.targets), targets: current.targets, undo: null};
    }
    const input = prepared.input as Extract<MioCanvasCopyInput, {operation: 'canvas.paste' | 'canvas.duplicate'}>['input'];
    const snapshotId = prepared.operation === 'canvas.paste' ? (input as {snapshotId: string}).snapshotId :
      copy((input as {targets: CanvasTarget[]}).targets).snapshotId;
    const at = new Date(time()).toISOString();
    const plan = clipboard.paste({projectId: store.projectId, documentId, snapshotId, viewport: input.viewport}, at);
    const baseline = {...plan.before, dependencyDigest: ''};
    const proof = patchEvidence(store, baseline, requester);
    const before: CanvasPatch = {...plan.before, dependencyDigest: proof};
    const after: CanvasPatch = {...plan.after, dependencyDigest: proof};
    assertCanvasEdgeEffects(store, after);
    applyCanvasPatch(store, before, after, at);
    const undo: MioCanvasCopyUndo = {
      before: encodeCanvasPatch(before),
      after: encodeCanvasPatch({...after, dependencyDigest: patchEvidence(store, after, requester)}),
      bindingDigest: digest(canvasPasteBindingEvidence(store, after.guards)),
    };
    undoEvidence(undo);
    const targets = targetLedger(store, after.guards);
    return {result: {created: plan.created, count: plan.created.length}, targets, undo};
  }
  function validateUndo(value: unknown, expected: readonly CanvasTargetExpectation[], requester?: MioCanvasRequester): void {
    check();
    readTransaction(store, () => {
      const undo = undoEvidence(value);
      validateMioCanvasUndo(store, {before: undo.before, after: undo.after}, expected, requester);
      if (digest(canvasPasteBindingEvidence(store, expected)) !== undo.bindingDigest) canvasError('mio-copy-bindings');
    });
  }
  function undo(value: unknown, expected: readonly CanvasTargetExpectation[], requester?: MioCanvasRequester): CanvasTargetExpectation[] {
    check();
    if (!store.db.isTransaction) throw new TypeError('Mio canvas copy undo requires the project transaction');
    validateUndo(value, expected, requester);
    const evidence = undoEvidence(value);
    return undoMioCanvasEdit(store, {before: evidence.before, after: evidence.after}, expected, requester);
  }
  return {prepare, apply, validateUndo, undo, dispose() {disposed = true; handles.clear();}};
}
