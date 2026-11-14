import {createHash, createHmac, randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {
  CANVAS_EDIT_LIMITS, canvasArchiveMediaSchema, canvasArchiveNodeTypeSchema, canvasEditingResponses, canvasEditingSchemas,
  canvasEditingWrites, readCanvasRequestId,
} from '../../contracts/src/canvas-editing.ts';
import type {
  CanvasArchiveItem, CanvasArchiveListInput, CanvasArchivePreviewInput, CanvasEditInput, CanvasEditResult, CanvasEditingOperation,
  CanvasHistoryInput, CanvasHistoryView, CanvasTarget,
} from '../../contracts/src/canvas-editing.ts';
import {AppError} from '../../contracts/src/app-error.ts';
import {isProjectId} from '../../contracts/src/project-file.ts';
import {hasCanvasArchives} from './canvas-active.ts';
import {validAssetLocator} from './asset-reference-record.ts';
import {INSPECTION_ROW_LIMITS} from './inspection-query.ts';
import {readMioTargetRevision} from './agent/mio-target-revisions.ts';
import {assertCanvasEdgeEffects, canvasEdgeEvidence, planCanvasArchive} from './canvas-archive.ts';
import {inspectCanvasDependencies} from './canvas-dependencies.ts';
import {
  activeShotOrder, applyCanvasPatch, canvasError, canvasKey, canvasLimit, compareCanvasTargets, decodeCanvasPatch, encodeCanvasPatch, expectCanvasRows,
  isCanvasGuardEvidence, isCanvasOrderOnlyRow,
  previousFields, readCanvasOrderAnchor, readCanvasRow,
} from './canvas-patch.ts';
import type {CanvasGuardEvidence, CanvasPatch} from './canvas-patch.ts';
import {readProjectContentStamp, sameContentStamp} from './project-file/content-stamp.ts';
import type {ProjectStore} from './project-file/store.ts';
import {canonicalJson} from './project-versions/document.ts';

const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(value)))).digest('hex');
const isRevision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 65536;
const CONFIRMATION_MS = 2 * 60_000;
const connectionKeys = new WeakMap<ProjectStore['db'], {confirmation: Buffer; epoch: string}>();

interface HistoryState {
  readonly position: number;
  readonly revision: number;
  readonly evidence: Readonly<Record<string, CanvasGuardEvidence>>;
}
interface HistoryEntry {
  readonly id: string;
  readonly position: number;
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
  const {db, projectId} = store;
  let keys = connectionKeys.get(db);
  if (!keys) {
    keys = {confirmation: randomBytes(32), epoch: randomBytes(16).toString('hex')};
    connectionKeys.set(db, keys);
  }
  const {confirmation: key, epoch: initialEpoch} = keys;
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
      Object.entries(evidence).some(([target, revision]) => !decodeKey(target) || !isCanvasGuardEvidence(revision))) return canvasError('invalid-history');
    return {position: row.position, revision: row.revision, evidence: evidence as Record<string, CanvasGuardEvidence>};
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
    return {id: row.id, position, operation: row.operation, before, after};
  };
  function decodeKey(target: string): CanvasTarget | null {
    const [kind, id, extra] = target.split(':');
    return extra === undefined && isProjectId(id) && (kind === 'shot' || kind === 'node' || kind === 'edge') ? {kind, id} : null;
  }
  function evidenceCurrent(current: HistoryState, entry: HistoryEntry): boolean {
    return entry.before.guards.every(target => {
      const prior = current.evidence[canvasKey(target)];
      const revision = typeof prior === 'number' ? prior : prior?.revision;
      if (revision === undefined || typeof prior === 'object' && entry.position < prior.since) return false;
      return readMioTargetRevision(db, projectId, target.kind, target.id) === revision;
    });
  }
  function history(current = state()) {
    const undo = entryAt(current.position), redo = entryAt(current.position + 1);
    const action = (entry: HistoryEntry | null) => entry && ({id: entry.id, operation: entry.operation, count: entry.after.rows.length});
    function availability(entry: HistoryEntry | null, backward: boolean): 'ready' | 'blocked' | 'conflict' {
      if (!entry) return 'ready';
      if (!evidenceCurrent(current, entry)) return 'conflict';
      const patch = backward ? entry.after : entry.before;
      const impact = patchEvidence(patch);
      if (impact.blocked.length) return 'blocked';
      if (patch.order && JSON.stringify(activeShotOrder(store)) !== JSON.stringify(patch.order)) return 'conflict';
      return impact.digest !== patch.dependencyDigest ? 'conflict' : 'ready';
    }
    const undoState = availability(undo, true), redoState = availability(redo, false);
    return {view: {revision: current.revision, undo: action(undo), redo: action(redo), conflict: undoState !== 'ready' || redoState !== 'ready'},
      undoConflict: undoState === 'conflict', redoConflict: redoState === 'conflict', undoBlocked: undoState === 'blocked', redoBlocked: redoState === 'blocked'};
  }
  function archivePlan(input: CanvasArchivePreviewInput, at: string, reportShotImpacts = false) {
    const {operation, targets} = input;
    const plan = planCanvasArchive(store, operation, targets, at, operation === 'restore' ? input.batchId : undefined);
    const effect = inspectCanvasDependencies(store, plan.before.guards, plan.selected, {reportShotImpacts});
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
    const outer = db.isTransaction;
    if (!outer) db.exec('BEGIN DEFERRED');
    try {
      const {plan, effect, facts} = archivePlan(input, now(), input.operation === 'archive');
      const historyRevision = state().revision, expires = time() + CONFIRMATION_MS;
      const confirmation = input.operation === 'archive' && (effect.versions || effect.clips) && !effect.blocked.length
        ? `${expires}.${sign(expires, facts, historyRevision)}` : null;
      const shotImpacts = (plan.before.order ?? []).flatMap((id, index) => {
        const impact = effect.shotImpacts.get(id);
        return impact ? [{number: index + 1, ...impact}] : [];
      });
      return {projectId, targets: plan.selected.map(({kind,id,revision}) => ({kind,id,revision})), affected: plan.after.rows.length,
        versions: effect.versions, clips: effect.clips, shotImpacts: shotImpacts.slice(0, CANVAS_EDIT_LIMITS.previewShots),
        impactedShotCount: shotImpacts.length, blocked: effect.blocked, confirmation, historyRevision};
    } finally {
      if (!outer && db.isTransaction) db.exec('COMMIT');
    }
  }
  function archived(input: CanvasArchiveListInput) {
    const outer = db.isTransaction;
    if (!outer) db.exec('BEGIN DEFERRED');
    try {
      const limit = input.limit ?? CANVAS_EDIT_LIMITS.archivedPage;
      const scope = "projectId=? AND archivedAt IS NOT NULL AND archiveReason='user-delete'";
      const total = db.prepare(`SELECT
        (SELECT count(*) FROM project.shots WHERE ${scope}) +
        (SELECT count(*) FROM project.nodes WHERE ${scope}) +
        (SELECT count(*) FROM project.edges WHERE ${scope}) AS total`).get(projectId, projectId, projectId)?.total;
      const rows = db.prepare(`SELECT kind,id FROM (
        SELECT 'shot' AS kind,id FROM project.shots WHERE ${scope}
        UNION ALL SELECT 'node',id FROM project.nodes WHERE ${scope}
        UNION ALL SELECT 'edge',id FROM project.edges WHERE ${scope}
      ) WHERE (id,kind)>(?,?) ORDER BY id,kind LIMIT ?`).all(projectId, projectId, projectId, input.after?.id ?? '', input.after?.kind ?? '', limit + 1);
      const page = rows.slice(0, limit).map(row => {
        const {kind,id} = row;
        if ((kind !== 'shot' && kind !== 'node' && kind !== 'edge') || !isProjectId(id)) return canvasError('invalid-record');
        return readCanvasRow(store, {kind,id});
      });
      const shots = page.filter(row => row.kind === 'shot').map(({id, data}) => [id, isProjectId(data.selectedVersionId) ? data.selectedVersionId : null] as const);
      const versions = archivedVersions(shots);
      const items = page.map(({kind, id, archive, revision, data}): CanvasArchiveItem => {
        if (!archive) return canvasError('invalid-record');
        const type = canvasArchiveNodeTypeSchema.safeParse(data.type);
        const nodeType = kind === 'node' && type.success ? type.data : null;
        const shot = versions.get(id);
        const media = kind === 'shot' ? archiveMedia(shot?.assetId, 'video') :
          nodeType === 'image' || nodeType === 'video' ? archiveMedia(data.assetId, nodeType) : null;
        const label = nodeType === 'text' ? data.label || data.text : data.title ?? (data.label || media?.name);
        // Early format-4 archives retain only their stored order index.
        const savedNumber = isRevision(data.orderIndex) && data.orderIndex < Number.MAX_SAFE_INTEGER ? data.orderIndex + 1 : null;
        const shotNumber = kind === 'shot' ? readCanvasOrderAnchor({kind, id, archive, revision, data}).number ?? savedNumber : null;
        return {kind, id, archive, revision, label: typeof label === 'string' ? label.slice(0, 512) : '',
          nodeType, shotNumber, versions: kind === 'shot' ? shot?.versions ?? 0 : 0, preview: media?.preview ?? null};
      });
      const last = items.at(-1);
      return {projectId, total, items, ...readProjectContentStamp(db),
        next: rows.length > limit && last ? {id:last.id, kind:last.kind} : null};
    } finally {
      if (!outer && db.isTransaction) db.exec('COMMIT');
    }
  }
  function archivedVersions(shots: readonly (readonly [string, string | null])[]) {
    const stats = new Map<string, {versions: number; assetId: unknown}>();
    if (!shots.length) return stats;
    // Decode bounded metadata in SQLite and return stats for this page's shots.
    const rows = db.prepare(`WITH owned AS (
      SELECT id,jobId,CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.versions}
        AND json_valid(data) THEN data END AS data FROM project.versions WHERE projectId=?
    ), projected AS (
      SELECT id,jobId,json_extract(data,'$.shotId') AS shotId,
        json_extract(data,'$.assetId') AS assetId
      FROM owned WHERE id=json_extract(data,'$.id') AND jobId=json_extract(data,'$.jobId')
        AND json_extract(data,'$.projectId')=?
    )
    SELECT shotId, count(*) AS versions,
      max(CASE WHEN id=json_extract(?, '$."' || shotId || '"') THEN assetId END) AS assetId
    FROM projected WHERE shotId IN (SELECT value FROM json_each(?)) GROUP BY shotId`)
      .all(projectId, projectId, JSON.stringify(Object.fromEntries(shots)), JSON.stringify(shots.map(([id]) => id)));
    for (const row of rows) {
      if (!isProjectId(row.shotId) || !isRevision(row.versions)) return canvasError('invalid-record');
      stats.set(row.shotId, {versions: row.versions, assetId: row.assetId});
    }
    return stats;
  }
  function archiveMedia(assetId: unknown, kind: 'image' | 'video') {
    if (!isProjectId(assetId)) return null;
    const row = db.prepare(`SELECT CASE WHEN length(CAST(data AS BLOB)) BETWEEN 1 AND ${INSPECTION_ROW_LIMITS.assets}
      AND json_valid(data) THEN data END AS data FROM project.assets WHERE projectId=? AND id=?`).get(projectId, assetId);
    if (typeof row?.data !== 'string') return null;
    const asset = JSON.parse(row.data);
    if (!asset || asset.id !== assetId || asset.projectId !== projectId || !validAssetLocator(db, asset)) return null;
    const preview = canvasArchiveMediaSchema.safeParse({assetId, mimeType: asset.mimeType});
    // Only disclose the identity. The existing project media gate decides
    // if its current locator is readable, including outside access.
    return preview.success && preview.data.mimeType.startsWith(`${kind}/`)
      ? {preview: preview.data, name: typeof asset.name === 'string' ? asset.name : ''} : null;
  }
  function saveState(current: HistoryState, position: number, patch: CanvasPatch, before: ReadonlyMap<string, number>,
    newEntry: boolean): HistoryState {
    const firstPosition = new Map<string, number>();
    const rows = db.prepare('SELECT position,beforePatch FROM main.canvas_history_entries WHERE projectId=? ORDER BY position LIMIT ?')
      .all(projectId, CANVAS_EDIT_LIMITS.historyEntries + 1);
    if (rows.length > CANVAS_EDIT_LIMITS.historyEntries) return canvasLimit();
    for (const row of rows) {
      if (!isRevision(row.position)) return canvasError('invalid-history');
      for (const target of decodeCanvasPatch(row.beforePatch).guards) {
        const key = canvasKey(target);
        if (!firstPosition.has(key)) firstPosition.set(key, row.position);
      }
    }
    const evidence = Object.fromEntries(Object.entries(current.evidence).filter(([key]) => firstPosition.has(key)));
    for (const target of patch.guards) {
      const key = canvasKey(target), previous = evidence[key];
      const prior = typeof previous === 'number' ? previous : previous?.revision;
      const revision = readMioTargetRevision(db, projectId, target.kind, target.id) ?? canvasError('invalid-revision', target);
      if (newEntry && (prior !== before.get(key) || typeof previous === 'object' && position < previous.since)) {
        // A new action may use a fresh external revision without blessing
        // older actions that depended on the same object before that write.
        evidence[key] = (firstPosition.get(key) ?? position) < position ? {revision, since: position} : revision;
      } else evidence[key] = typeof previous === 'object' ? {...previous, revision} : revision;
    }
    const guarded = new Set(patch.guards.map(canvasKey));
    for (const row of patch.rows) {
      const key = canvasKey(row);
      if (!isCanvasOrderOnlyRow(row) || guarded.has(key)) continue;
      const previous = evidence[key];
      const prior = typeof previous === 'number' ? previous : previous?.revision;
      // Order compaction advances the shared revision. Carry that advance into
      // other actions only if their evidence already matched before the write.
      if (prior === undefined || prior !== before.get(key)) continue;
      const revision = readMioTargetRevision(db, projectId, row.kind, row.id) ??
        canvasError('invalid-revision', {kind: row.kind, id: row.id});
      evidence[key] = typeof previous === 'object' ? {...previous, revision} : revision;
    }
    const revision = current.revision + 1;
    const encoded = JSON.stringify(evidence);
    if (Buffer.byteLength(encoded) > MAX_PATCH_BYTES) return canvasLimit();
    db.prepare(`INSERT INTO main.canvas_history_state(projectId,position,revision,evidence) VALUES(?,?,?,?)
      ON CONFLICT(projectId) DO UPDATE SET position=excluded.position,revision=excluded.revision,evidence=excluded.evidence`)
      .run(projectId, position, revision, encoded);
    return {position, revision, evidence};
  }
  function readGuardRevisions(current: HistoryState, patch: CanvasPatch): Map<string, number> {
    const targets = new Map(patch.guards.map(target => [canvasKey(target), target]));
    for (const row of patch.rows) {
      const key = canvasKey(row);
      if (isCanvasOrderOnlyRow(row) && Object.hasOwn(current.evidence, key)) targets.set(key, {kind: row.kind, id: row.id});
    }
    return new Map([...targets].map(([key, target]) =>
      [key, readMioTargetRevision(db, projectId, target.kind, target.id) ?? canvasError('invalid-revision', target)]));
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
    ({projectId, actionId, affected, history: history(current).view, ...readProjectContentStamp(db)});
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
    const position = current.position + 1;
    if (!isRevision(position) || current.revision >= Number.MAX_SAFE_INTEGER) return canvasLimit();
    const first = encodeCanvasPatch(before);
    if (Buffer.byteLength(first) + Buffer.byteLength(encodeCanvasPatch(after)) > MAX_PATCH_BYTES) return canvasLimit();
    const revisions = readGuardRevisions(current, before);
    applyCanvasPatch(store, before, after, at);
    const second = encodeCanvasPatch({...after, dependencyDigest: patchEvidence(after).digest});
    db.prepare('DELETE FROM main.canvas_history_entries WHERE projectId=? AND position>=?').run(projectId, position);
    const id = randomUUID();
    db.prepare('INSERT INTO main.canvas_history_entries(id,projectId,position,operation,beforePatch,afterPatch,createdAt) VALUES(?,?,?,?,?,?,?)')
      .run(id, projectId, position, input.operation, first, second, at);
    prune();
    return result(id, after.rows.length, saveState(current, position, after, revisions, true));
  }
  function travel(undo: boolean, current: HistoryState, at: string): CanvasEditResult {
    const target = entryAt(current.position + (undo ? 0 : 1));
    if (!target) return result(null, 0, current);
    if (!evidenceCurrent(current, target)) return canvasError('history-revision');
    const before = undo ? target.after : target.before, after = undo ? target.before : target.after;
    const effect = patchEvidence(before);
    assertUnblocked(effect);
    if (effect.digest !== before.dependencyDigest) return canvasError('history-dependencies');
    if (current.revision >= Number.MAX_SAFE_INTEGER) return canvasLimit();
    assertCanvasEdgeEffects(store, after);
    const revisions = readGuardRevisions(current, before);
    applyCanvasPatch(store, before, after, at);
    return result(target.id, after.rows.length, saveState(current, current.position + (undo ? -1 : 1), after, revisions, false));
  }
  function receiptWindow() {
    const row = db.prepare('SELECT epoch,floor FROM main.canvas_receipt_window WHERE singleton=1').get();
    if (!row) return {epoch: initialEpoch, floor: 0};
    if (typeof row.epoch !== 'string' || !/^[0-9a-f]{32}$/u.test(row.epoch) || !isRevision(row.floor) || row.floor > 9_999_999_999_999) {
      return canvasError('invalid-receipt-window');
    }
    return {epoch: row.epoch, floor: row.floor};
  }
  const cutoff = (floor: number, clock: number): number => Math.max(floor, clock - CANVAS_EDIT_LIMITS.receiptLifetimeMs);
  const unknownReceipt = (requestId: string): never => {
    throw new AppError('CANVAS_REQUEST_OUTCOME_UNKNOWN', '画布请求已过期或本机记录已更换。请重新读取画布，核对操作结果。', 409,
      {requestId, submissionMayHaveSucceeded: true, recovery: 'refresh_canvas'});
  };
  function prepareReceiptSpace(epoch: string, floor: number) {
    const expired = new Date(floor).toISOString();
    db.prepare(`INSERT INTO main.canvas_receipt_window(singleton,epoch,floor) VALUES(1,?,?)
      ON CONFLICT(singleton) DO UPDATE SET floor=excluded.floor WHERE floor<excluded.floor`).run(epoch, floor);
    db.prepare('DELETE FROM main.canvas_requests WHERE issuedAt<=?').run(floor);
    db.prepare('DELETE FROM main.canvas_requests WHERE issuedAt IS NULL AND createdAt<=?').run(expired);
    const usage = db.prepare(`SELECT count(*) AS rows,coalesce(sum(length(CAST(response AS BLOB))),0) AS bytes,
      min(issuedAt) AS earliest,min(CASE WHEN issuedAt IS NULL THEN createdAt END) AS earliestLegacy
      FROM main.canvas_requests WHERE projectId=?`).get(projectId)!;
    return {rows: Number(usage.rows), bytes: Number(usage.bytes), retryAfter: Math.min(
      typeof usage.earliest === 'number' ? usage.earliest : Infinity,
      typeof usage.earliestLegacy === 'string' ? Date.parse(usage.earliestLegacy) : Infinity,
    ) + CANVAS_EDIT_LIMITS.receiptLifetimeMs};
  }
  function receiptCapacity(retryAfter: number): never {
    throw new AppError('CANVAS_RECEIPT_WINDOW_FULL', '画布请求回执暂时已满，请在旧回执过期后重试。', 409,
      {retryAfter: new Date(retryAfter).toISOString()});
  }
  function mutation(operation: 'canvas.apply' | 'canvas.history.undo' | 'canvas.history.redo',
    input: CanvasEditInput | CanvasHistoryInput, authorize: () => void): CanvasEditResult {
    const mode = operation === 'canvas.apply' ? (input as CanvasEditInput).operation : operation === 'canvas.history.undo' ? 'undo' : 'redo';
    const normalized = 'targets' in input ? {...input, targets: [...input.targets].sort(compareCanvasTargets)}
      : 'moves' in input ? {...input, moves: [...input.moves].sort(compareCanvasTargets)} : input;
    const inputDigest = digest({operation, input: normalized});
    return store.tx(() => {
      authorize();
      const clock = time(), {epoch, floor} = receiptWindow(), expiresBefore = cutoff(floor, clock);
      const old = db.prepare('SELECT projectId,operation,inputDigest,response,createdAt,issuedAt FROM main.canvas_requests WHERE requestId=?').get(input.requestId);
      if (old) {
        const issuedAt = old.issuedAt ?? Date.parse(String(old.createdAt));
        if (!isRevision(issuedAt)) return canvasError('invalid-receipt');
        if (issuedAt <= expiresBefore) return unknownReceipt(input.requestId);
        if (old.projectId !== projectId || old.operation !== mode || old.inputDigest !== inputDigest) {
          throw new AppError('REQUEST_ID_REUSED', '请求 ID 已用于不同的画布操作。', 409);
        }
        try {
          const receipt = canvasEditingResponses[operation].parse(JSON.parse(String(old.response)));
          if (receipt.projectId !== projectId) return canvasError('invalid-receipt');
          return receipt;
        } catch { return canvasError('invalid-receipt'); }
      }
      const request = readCanvasRequestId(input.requestId);
      if (!request || request.epoch !== epoch || request.issuedAt <= expiresBefore) return unknownReceipt(input.requestId);
      if (request.issuedAt > clock + CANVAS_EDIT_LIMITS.requestClockSkewMs) {
        throw new AppError('VALIDATION_ERROR', '画布请求时间超出允许范围。', 400);
      }
      const current = state();
      if (input.historyRevision !== current.revision) return canvasError('history-revision');
      const usage = prepareReceiptSpace(epoch, expiresBefore);
      if (usage.rows >= CANVAS_EDIT_LIMITS.receiptRows) return receiptCapacity(usage.retryAfter);
      const at = now();
      const saved = operation === 'canvas.apply' ? edit(input as CanvasEditInput, current, at)
        : travel(operation === 'canvas.history.undo', current, at);
      const response = JSON.stringify(canvasEditingResponses[operation].parse(saved)), bytes = Buffer.byteLength(response);
      if (bytes > MAX_RECEIPT_BYTES) return canvasLimit();
      if (usage.bytes + bytes > CANVAS_EDIT_LIMITS.receiptBytes) return receiptCapacity(usage.retryAfter);
      db.prepare('INSERT INTO main.canvas_requests(requestId,projectId,operation,inputDigest,response,createdAt,issuedAt) VALUES(?,?,?,?,?,?,?)')
        .run(input.requestId, projectId, mode, inputDigest, response, at, request.issuedAt);
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
      if (operation === 'canvas.history.get') {
        const {view, ...availability} = history(), {epoch, floor} = receiptWindow();
        return {...view, ...availability, requestEpoch: epoch, requestAfter: cutoff(floor, time())};
      }
      return mutation(operation, parsed.data as CanvasEditInput | CanvasHistoryInput, authorize);
    },
  };
}

export const isCanvasEditingWrite = (operation: string): boolean => (canvasEditingWrites as readonly string[]).includes(operation);
