import {createHash, createHmac, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {
  CANVAS_EDIT_LIMITS, canvasEditingResponses, canvasEditingSchemas, canvasEditingWrites,
} from '../../contracts/src/canvas-editing.ts';
import type {
  CanvasArchiveListInput, CanvasArchivePreviewInput, CanvasEditInput, CanvasEditResult, CanvasEditingOperation,
  CanvasHistoryInput, CanvasHistoryView, CanvasTarget,
} from '../../contracts/src/canvas-editing.ts';
import {AppError} from '../../contracts/src/app-error.ts';
import {isProjectId} from '../../contracts/src/project-file.ts';
import {hasCanvasArchives} from './canvas-active.ts';
import {readMioTargetRevision} from './agent/mio-target-revisions.ts';
import {assertCanvasEdgeEffects, canvasEdgeEvidence, planCanvasArchive} from './canvas-archive.ts';
import {inspectCanvasDependencies} from './canvas-dependencies.ts';
import {
  activeShotOrder, applyCanvasPatch, canvasError, canvasKey, canvasLimit, compareCanvasTargets, decodeCanvasPatch, encodeCanvasPatch, expectCanvasRows,
  previousFields, readCanvasRow,
} from './canvas-patch.ts';
import type {CanvasPatch} from './canvas-patch.ts';
import {readProjectContentStamp, sameContentStamp} from './project-file/content-stamp.ts';
import type {ProjectStore} from './project-file/store.ts';
import {canonicalJson} from './project-versions/document.ts';

const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest('hex');
const isRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 65536;
const CONFIRMATION_MS = 2 * 60_000;

interface HistoryState {
  readonly position: number;
  readonly revision: number;
  readonly evidence: Readonly<Record<string, number>>;
}
interface HistoryEntry {
  readonly id: string;
  readonly operation: 'archive' | 'restore' | 'move' | 'layout';
  readonly before: CanvasPatch;
  readonly after: CanvasPatch;
}

const assertUnblocked = (effects: ReturnType<typeof inspectCanvasDependencies>): void => {
  if (effects.blocked.length) throw new AppError('CANVAS_EDIT_BLOCKED', '画布对象有未完成的操作。', 409, {blocked: effects.blocked});
};

export function createCanvasEditing(store: ProjectStore, {now = () => new Date().toISOString(), time = Date.now}: {
  readonly now?: () => string;
  readonly time?: () => number;
} = {}) {
  const {db, projectId} = store, key = randomBytes(32);
  const dependency = (targets: readonly CanvasTarget[]) => inspectCanvasDependencies(store, targets);
  function patchEvidence(patch: Pick<CanvasPatch, 'guards' | 'rows'>) {
    const impact = dependency(patch.guards);
    return {...impact, digest: digest([impact.digest, canvasEdgeEvidence(store, patch)])};
  }
  const state = (): HistoryState => {
    const row = db.prepare('SELECT position,revision,evidence FROM main.canvas_history_state WHERE projectId=?').get(projectId);
    if (!row) return {position: 0, revision: 0, evidence: {}};
    let evidence: unknown;
    try { evidence = JSON.parse(String(row.evidence)); } catch { return canvasError('invalid-history'); }
    if (!isRevision(row.position) || !isRevision(row.revision) || !evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
      Object.entries(evidence).some(([target, revision]) => !decodeKey(target) || !isRevision(revision))) return canvasError('invalid-history');
    return {position: row.position, revision: row.revision, evidence: evidence as Record<string, number>};
  };
  const entryAt = (position: number): HistoryEntry | null => {
    const row = db.prepare('SELECT id,operation,beforePatch,afterPatch FROM main.canvas_history_entries WHERE projectId=? AND position=?').get(projectId, position);
    if (!row) return null;
    if (!isProjectId(row.id) || (row.operation !== 'archive' && row.operation !== 'restore' && row.operation !== 'move' && row.operation !== 'layout')) {
      return canvasError('invalid-history');
    }
    const before = decodeCanvasPatch(row.beforePatch), after = decodeCanvasPatch(row.afterPatch);
    const guards = before.guards.map(canvasKey);
    if (JSON.stringify(guards) !== JSON.stringify(after.guards.map(canvasKey))) return canvasError('invalid-history');
    return {id: row.id, operation: row.operation, before, after};
  };
  function decodeKey(target: string): CanvasTarget | null {
    const [kind, id, extra] = target.split(':');
    return extra === undefined && isProjectId(id) && (kind === 'shot' || kind === 'node' || kind === 'edge') ? {kind, id} : null;
  }
  function evidenceCurrent(current: HistoryState, entries: readonly (HistoryEntry | null)[]): boolean {
    if (entries.some(entry => entry?.before.guards.some(target => !Object.hasOwn(current.evidence, canvasKey(target))))) return false;
    for (const [target, revision] of Object.entries(current.evidence)) {
      const {kind, id} = decodeKey(target)!;
      try { if (readMioTargetRevision(db, projectId, kind, id) !== revision) return false; }
      catch (error) { if (error instanceof AppError) return false; throw error; }
    }
    return true;
  }
  function history(current = state()): CanvasHistoryView {
    const undo = entryAt(current.position), redo = entryAt(current.position + 1);
    let conflict = !evidenceCurrent(current, [undo, redo]);
    const action = (entry: HistoryEntry | null) => entry && ({id: entry.id, operation: entry.operation, count: entry.after.rows.length});
    if (!conflict) conflict = [undo?.after, redo?.before].some(patch => {
      if (!patch) return false;
      if (patch.order && JSON.stringify(activeShotOrder(store)) !== JSON.stringify(patch.order)) return true;
      const impact = patchEvidence(patch);
      return Boolean(impact.blocked.length || impact.digest !== patch.dependencyDigest);
    });
    return {revision: current.revision, undo: action(undo), redo: action(redo), conflict};
  }
  function archivePlan(input: CanvasArchivePreviewInput, at: string) {
    const {operation, targets} = input;
    const plan = planCanvasArchive(store, operation, targets, at, operation === 'restore' ? input.batchId : undefined);
    const effect = inspectCanvasDependencies(store, plan.before.guards, plan.selected);
    const closure = plan.before.guards.map(target => {
      return [target.kind, target.id, readMioTargetRevision(db, projectId, target.kind, target.id) ?? canvasError('invalid-revision', target)];
    });
    const facts = digest({operation, projectId, selected: plan.selected.map(({kind,id,revision}) => ({kind,id,revision})),
      content: readProjectContentStamp(db), order: plan.before.order, closure, dependencies: effect.digest});
    return {plan, effect, facts};
  }
  const sign = (expires: number, facts: string, revision: number) =>
    createHmac('sha256', key).update(JSON.stringify([expires, facts, revision])).digest('hex');
  function verifyConfirmation(value: string | undefined, facts: string, revision: number): void {
    const parsed = /^(\d{1,16})\.([0-9a-f]{64})$/u.exec(value ?? '');
    if (!parsed || !isRevision(Number(parsed[1])) || Number(parsed[1]) < time() ||
      !timingSafeEqual(Buffer.from(parsed[2]!, 'hex'), Buffer.from(sign(Number(parsed[1]), facts, revision), 'hex'))) {
      throw new AppError('CANVAS_CONFIRMATION_REQUIRED', '影响已变化或确认已过期，请重新预检。', 409);
    }
  }
  function preview(input: CanvasArchivePreviewInput) {
    const {plan, effect, facts} = archivePlan(input, now());
    const historyRevision = state().revision, expires = time() + CONFIRMATION_MS;
    const confirmation = input.operation === 'archive' && (effect.versions || effect.clips) && !effect.blocked.length
      ? `${expires}.${sign(expires, facts, historyRevision)}` : null;
    return {projectId, targets: plan.selected.map(({kind,id,revision}) => ({kind,id,revision})), affected: plan.after.rows.length,
      versions: effect.versions, clips: effect.clips, blocked: effect.blocked, confirmation, historyRevision};
  }
  function archived(input: CanvasArchiveListInput) {
    const limit = input.limit ?? CANVAS_EDIT_LIMITS.archivedPage;
    const rows = db.prepare(`SELECT kind,id FROM (
      SELECT 'shot' AS kind,id FROM project.shots WHERE projectId=? AND archiveReason='user-delete'
      UNION ALL SELECT 'node',id FROM project.nodes WHERE projectId=? AND archiveReason='user-delete'
      UNION ALL SELECT 'edge',id FROM project.edges WHERE projectId=? AND archiveReason='user-delete'
    ) WHERE (id,kind)>(?,?) ORDER BY id,kind LIMIT ?`).all(projectId, projectId, projectId, input.after?.id ?? '', input.after?.kind ?? '', limit + 1);
    const items = rows.slice(0, limit).map(value => {
      const item = value as unknown as CanvasTarget;
      const {kind, id, archive, revision, data} = readCanvasRow(store, item);
      if (!archive) return canvasError('invalid-record');
      const label = data.title ?? data.label;
      return {kind, id, archive, revision, label: typeof label === 'string' ? label.slice(0, 512) : ''};
    });
    const last = items.at(-1);
    return {projectId, items, next: rows.length > limit && last ? {id:last.id, kind:last.kind} : null};
  }
  function saveState(position: number, revision: number): HistoryState {
    const targets = new Map<string, CanvasTarget>();
    const rows = db.prepare('SELECT beforePatch FROM main.canvas_history_entries WHERE projectId=? ORDER BY position LIMIT ?')
      .all(projectId, CANVAS_EDIT_LIMITS.historyEntries + 1);
    if (rows.length > CANVAS_EDIT_LIMITS.historyEntries) return canvasLimit();
    for (const row of rows) for (const target of decodeCanvasPatch(row.beforePatch).guards) targets.set(canvasKey(target), target);
    const evidence = Object.fromEntries([...targets].map(([key, {kind,id}]) => [key,
      readMioTargetRevision(db, projectId, kind, id) ?? canvasError('invalid-revision', {id})]));
    const encoded = JSON.stringify(evidence);
    if (Buffer.byteLength(encoded) > MAX_PATCH_BYTES) return canvasLimit();
    db.prepare(`INSERT INTO main.canvas_history_state(projectId,position,revision,evidence) VALUES(?,?,?,?)
      ON CONFLICT(projectId) DO UPDATE SET position=excluded.position,revision=excluded.revision,evidence=excluded.evidence`)
      .run(projectId, position, revision, encoded);
    return {position, revision, evidence};
  }
  function prune(): void {
    const rows = db.prepare(`SELECT position,length(CAST(beforePatch AS BLOB))+length(CAST(afterPatch AS BLOB)) AS bytes
      FROM main.canvas_history_entries WHERE projectId=? ORDER BY position DESC`).all(projectId);
    let bytes = 0, keep = 0;
    for (const row of rows) {
      bytes += Number(row.bytes);
      if (++keep > CANVAS_EDIT_LIMITS.historyEntries || bytes > CANVAS_EDIT_LIMITS.historyBytes) {
        db.prepare('DELETE FROM main.canvas_history_entries WHERE projectId=? AND position<=?').run(projectId, row.position!);
        break;
      }
    }
  }
  const result = (actionId: string | null, affected: number, current: HistoryState): CanvasEditResult =>
    ({projectId, actionId, affected, history: history(current), ...readProjectContentStamp(db)});
  function edit(input: CanvasEditInput, current: HistoryState, at: string): CanvasEditResult {
    let before: CanvasPatch, after: CanvasPatch;
    if (input.operation === 'archive' || input.operation === 'restore') {
      const {plan, effect, facts} = archivePlan(input, at);
      assertUnblocked(effect);
      if (input.confirmation !== undefined || input.operation === 'archive' && (effect.versions || effect.clips)) {
        verifyConfirmation(input.confirmation, facts, current.revision);
      }
      const proof = patchEvidence(plan.before).digest;
      before = {...plan.before, dependencyDigest: proof};
      after = {...plan.after, dependencyDigest: proof};
    } else {
      if (input.operation === 'layout' && !sameContentStamp(readProjectContentStamp(db), input)) return canvasError('layout-base');
      const moves = [...input.moves].sort(compareCanvasTargets);
      const rows = expectCanvasRows(store, moves, false);
      const updates = rows.map((row, index) => ({kind: row.kind, id: row.id, fields: {position: moves[index]!.position}}));
      const changed = updates.map((row, index) => ({row, old: previousFields(rows[index]!, row.fields)}))
        .filter(({row, old}) => old.position?.x !== row.fields.position.x || old.position?.y !== row.fields.position.y);
      if (!changed.length) return result(null, 0, current);
      const guards = updates.map(({kind,id}) => ({kind,id})), effect = dependency(guards);
      assertUnblocked(effect);
      const fields = {version: 1 as const, guards, anchors: [], order: null, dependencyDigest: digest([effect.digest, []])};
      before = {...fields, rows: changed.map(({row, old}) => ({kind: row.kind, id: row.id, fields: old}))};
      after = {...fields, rows: changed.map(({row}) => row)};
    }
    const reset = history(current).conflict, position = reset ? 1 : current.position + 1;
    if (!isRevision(position) || current.revision >= Number.MAX_SAFE_INTEGER) return canvasLimit();
    const first = encodeCanvasPatch(before);
    if (Buffer.byteLength(first) + Buffer.byteLength(encodeCanvasPatch(after)) > MAX_PATCH_BYTES) return canvasLimit();
    applyCanvasPatch(store, before, after, at);
    const second = encodeCanvasPatch({...after, dependencyDigest: patchEvidence(after).digest});
    db.prepare('DELETE FROM main.canvas_history_entries WHERE projectId=? AND position>=?').run(projectId, position);
    const id = randomUUID();
    db.prepare('INSERT INTO main.canvas_history_entries(id,projectId,position,operation,beforePatch,afterPatch,createdAt) VALUES(?,?,?,?,?,?,?)')
      .run(id, projectId, position, input.operation, first, second, at);
    prune();
    return result(id, after.rows.length, saveState(position, current.revision + 1));
  }
  function travel(undo: boolean, current: HistoryState, at: string): CanvasEditResult {
    const target = entryAt(current.position + (undo ? 0 : 1));
    if (!target) return result(null, 0, current);
    if (!evidenceCurrent(current, [target])) return canvasError('history-revision');
    const before = undo ? target.after : target.before, after = undo ? target.before : target.after;
    const effect = patchEvidence(before);
    assertUnblocked(effect);
    if (effect.digest !== before.dependencyDigest) return canvasError('history-dependencies');
    if (current.revision >= Number.MAX_SAFE_INTEGER) return canvasLimit();
    assertCanvasEdgeEffects(store, after);
    applyCanvasPatch(store, before, after, at);
    return result(target.id, after.rows.length, saveState(current.position + (undo ? -1 : 1), current.revision + 1));
  }
  function mutation(operation: 'canvas.apply' | 'canvas.history.undo' | 'canvas.history.redo',
    input: CanvasEditInput | CanvasHistoryInput, authorize: () => void): CanvasEditResult {
    const mode = operation === 'canvas.apply' ? (input as CanvasEditInput).operation : operation === 'canvas.history.undo' ? 'undo' : 'redo';
    const normalized = 'targets' in input ? {...input, targets: [...input.targets].sort(compareCanvasTargets)}
      : 'moves' in input ? {...input, moves: [...input.moves].sort(compareCanvasTargets)} : input;
    const inputDigest = digest({operation, input: normalized});
    return store.tx(() => {
      authorize();
      const old = db.prepare('SELECT projectId,operation,inputDigest,response FROM main.canvas_requests WHERE requestId=?').get(input.requestId);
      if (old) {
        if (old.projectId !== projectId || old.operation !== mode || old.inputDigest !== inputDigest) {
          throw new AppError('REQUEST_ID_REUSED', '请求 ID 已用于不同的画布操作。', 409);
        }
        try {
          const receipt = canvasEditingResponses[operation].parse(JSON.parse(String(old.response)));
          if (receipt.projectId !== projectId) return canvasError('invalid-receipt');
          return receipt;
        } catch { return canvasError('invalid-receipt'); }
      }
      const usage = db.prepare('SELECT count(*) AS rows,coalesce(sum(length(CAST(response AS BLOB))),0) AS bytes FROM main.canvas_requests WHERE projectId=?').get(projectId)!;
      if (Number(usage.rows) >= CANVAS_EDIT_LIMITS.receiptRows) return canvasLimit();
      const current = state();
      if (input.historyRevision !== current.revision) return canvasError('history-revision');
      const at = now();
      const saved = operation === 'canvas.apply' ? edit(input as CanvasEditInput, current, at)
        : travel(operation === 'canvas.history.undo', current, at);
      const response = JSON.stringify(canvasEditingResponses[operation].parse(saved)), bytes = Buffer.byteLength(response);
      if (bytes > MAX_RECEIPT_BYTES || Number(usage.bytes) + bytes > CANVAS_EDIT_LIMITS.receiptBytes) return canvasLimit();
      db.prepare('INSERT INTO main.canvas_requests(requestId,projectId,operation,inputDigest,response,createdAt) VALUES(?,?,?,?,?,?)')
        .run(input.requestId, projectId, mode, inputDigest, response, at);
      authorize();
      return saved;
    });
  }
  return {
    call(operation: CanvasEditingOperation, input: unknown, authorize: () => void = () => {}): unknown {
      if (!hasCanvasArchives(db)) throw new AppError('UNKNOWN_OPERATION', '未知操作', 404);
      const parsed = canvasEditingSchemas[operation].safeParse(input);
      if (!parsed.success || parsed.data.projectId !== projectId) throw new AppError('VALIDATION_ERROR', '画布操作参数无效。', 400);
      if (operation === 'canvas.archive.preview') return canvasEditingResponses[operation].parse(preview(parsed.data as CanvasArchivePreviewInput));
      if (operation === 'canvas.archive.list') return canvasEditingResponses[operation].parse(archived(parsed.data as CanvasArchiveListInput));
      if (operation === 'canvas.history.get') return history();
      return mutation(operation, parsed.data as CanvasEditInput | CanvasHistoryInput, authorize);
    },
  };
}

export const isCanvasEditingWrite = (operation: string): boolean => (canvasEditingWrites as readonly string[]).includes(operation);
