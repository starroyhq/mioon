/** Previs scene actions as one shared `sequence-edit` board action (G line).
 *
 * The previs card adds mannequin/prop subject references, and FR-0 requires the
 * format-5 previs writes to go through the unified sequence entry instead of the
 * legacy receipt writer. This module plans one previs create/save:
 * - reads the live previs node and applies scene-revision CAS,
 * - resolves every `{subjectId, subjectVersionId?}` through SB-a's
 *   `resolvePrevisSubjectReference` (existence, project ownership, hidden
 *   versions) without re-implementing that resolver,
 * - validates new keyframe export images, capacities and revision bounds,
 * - returns the board before/after node rows plus the thumbnail prune.
 *
 * `runPrevisSync` (in `format5-sequence-sync.ts`) applies the delta and writes
 * one history-13 entry + receipt; this file never opens a transaction.
 */
import {AppError} from '../../contracts/src/app-error.ts';
import {
  PREVIS_LIMITS, defaultPrevisScene, isPrevisNodeRecord, previsSceneSubjectReferences,
} from '../../contracts/src/previs.ts';
import type {PrevisNodeRecord, PrevisScene, PrevisSubjectReferenceEntry} from '../../contracts/src/previs.ts';
import type {
  SequenceEditBoardEntity, SequenceEditEnvelope, SequenceEditExpectedTarget, SequenceEditImpact,
  SequenceEditPrevisIntent, SequenceEditStateDelta, SequenceEditTimelineDelta,
} from '../../contracts/src/sequence-edit.ts';
import {SEQUENCE_EDIT_CONTRACT_VERSION, isSequenceEditEnvelope} from '../../contracts/src/sequence-edit.ts';
import type {ProjectStore} from './project-file/store.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import {readFormat5TimelineState} from './project-file/format5-timeline.ts';
import {prepareSequenceEditHistory, sequenceEditInputDigest} from './format5-editor-history.ts';
import {readMioTargetRevision} from './agent/mio-target-revisions.ts';
import {resolvePrevisSubjectReference} from './format5-subject-binding.ts';
import {isSubjectVersionHidden} from './subject-variant-visibility.ts';
import {isCanvasArchived} from './canvas-active.ts';
import {assertPrevisSceneExports} from './previs.ts';

type Row = Record<string, unknown>;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
const now = (): string => new Date().toISOString();
const isFormat5 = (store: ProjectStore): boolean =>
  Number(store.db.prepare('PRAGMA project.user_version').get()?.user_version) === FORMAT5_PROJECT_SCHEMA_VERSION;
function invalid(message: string, details: Row = {}): never {
  throw new AppError('SEQUENCE_EDIT_PREVIS_INVALID', message, 409, details);
}
function conflict(message: string, details: Row = {}): never {
  throw new AppError('SEQUENCE_EDIT_REVISION_CONFLICT', message, 409, details);
}

const UNCHANGED_TIMELINE: SequenceEditTimelineDelta = Object.freeze({clips: [], cues: [], removedClipIds: [],
  removedCueIds: [], baseline: Object.freeze({kind: 'unchanged' as const})});
const stateDelta = (writes: readonly SequenceEditBoardEntity[], removals: readonly SequenceEditBoardEntity[]): SequenceEditStateDelta =>
  ({board: {writes, removals}, timeline: UNCHANGED_TIMELINE});
const nodeEntity = (value: PrevisNodeRecord): SequenceEditBoardEntity =>
  ({kind: 'node', id: value.id, data: {...value} as unknown as Row});

/** Active sequence root this project's board edits belong to. */
function filmRoot(store: ProjectStore): string {
  const state = readFormat5TimelineState(store.db, 'project');
  if (!state.header) throw new AppError('PROJECT_INVALID', '项目没有格式 5 时间线', 422, {database: 'project', reason: 'metadata'});
  const header = JSON.parse(state.header.raw) as Row;
  const mainTrack = header.mainTrack as Row | undefined;
  if (!mainTrack || typeof mainTrack.sequenceNodeId !== 'string' || !isUuid(mainTrack.sequenceNodeId)) invalid('时间线缺少顺序根');
  return mainTrack.sequenceNodeId;
}

function count(store: ProjectStore, sql: string, ...values: string[]): number {
  return Number(store.db.prepare(sql).get(...values)!.n);
}
function livePrevisNode(store: ProjectStore, nodeId: string): PrevisNodeRecord {
  const row = store.db.prepare(`SELECT projectId,CASE WHEN json_valid(data) THEN json_extract(data,'$.type') END AS type,
    CASE WHEN length(CAST(data AS BLOB))<=${PREVIS_LIMITS.nodeBytes} THEN data END AS data FROM project.nodes WHERE id=?`).get(nodeId);
  if (!row || row.projectId !== store.projectId) invalid('预演节点不存在或不属于当前项目', {nodeId});
  if (row.type !== 'previs') invalid('这个节点不是机位预演', {nodeId});
  if (typeof row.data !== 'string') invalid('预演节点记录无法验证', {nodeId});
  let value: unknown;
  try { value = JSON.parse(row.data); } catch { invalid('预演节点记录无法验证', {nodeId}); }
  if (!isPrevisNodeRecord(value) || value.id !== nodeId || value.projectId !== store.projectId) {
    invalid('预演节点记录无法验证', {nodeId});
  }
  if (isCanvasArchived(store.db, 'nodes', nodeId)) invalid('预演节点已删除', {nodeId});
  return value;
}

export interface ResolvedPrevisSubject {
  readonly elementKind: 'figure' | 'prop';
  readonly elementId: string;
  readonly subjectId: string;
  readonly subjectVersionId: string;
  readonly mode: 'follow' | 'locked';
  readonly sha256: string;
  readonly mimeType: string;
}

/**
 * Resolve every mannequin/prop subject reference of a scene. A follow reference
 * resolves its current head once here (validation and the seam RI/GE will use
 * when a previs output becomes a generation input); a locked reference keeps its
 * version. Hidden versions of an undone variant batch are refused even though
 * they stay readable as history evidence.
 */
export function resolvePrevisSceneSubjects(store: ProjectStore, scene: PrevisScene): readonly ResolvedPrevisSubject[] {
  return previsSceneSubjectReferences(scene).map((entry: PrevisSubjectReferenceEntry) => {
    const resolved = resolvePrevisSubjectReference(store, {subjectId: entry.reference.subjectId,
      subjectVersionId: entry.reference.subjectVersionId ?? null});
    if (isSubjectVersionHidden(store.db, resolved.subjectVersionId)) {
      throw new AppError('SEQUENCE_EDIT_SUBJECT_VERSION_HIDDEN', '这个主体版本属于已撤销的补角度批次，已隐藏', 409, {});
    }
    return {elementKind: entry.elementKind, elementId: entry.elementId, subjectId: resolved.subjectId,
      subjectVersionId: resolved.subjectVersionId, mode: resolved.mode, sha256: resolved.sha256, mimeType: resolved.mimeType};
  });
}

export interface PrevisPlan {
  readonly before: SequenceEditStateDelta;
  readonly after: SequenceEditStateDelta;
  readonly nodeId: string;
  /** Keyframe thumbnails of the replaced scene that no longer match a camera. */
  readonly prune?: {readonly nodeId: string; readonly current: PrevisScene; readonly next: PrevisScene};
}

/** Validate one previs intent against the live project and plan the node row. */
export function planPrevisAction(store: ProjectStore, envelope: SequenceEditEnvelope): PrevisPlan {
  if (!isFormat5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于格式 5 项目。', 409, {reason: 'FORMAT_REQUIRED'});
  const intent = envelope.previsIntent;
  if (!intent || envelope.intents.length !== 0 || envelope.subjectIntent !== undefined || envelope.propertiesIntent !== undefined) {
    invalid('预演动作必须且只能携带一个 previs intent');
  }
  if (envelope.filmId !== filmRoot(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '成片根与当前项目不一致。', 409);
  const operation = intent.operation;
  if (operation.kind === 'previs-create') return planCreate(store, envelope, intent, operation);
  return planSceneSet(store, envelope, operation);
}

function planCreate(store: ProjectStore, envelope: SequenceEditEnvelope, intent: SequenceEditPrevisIntent,
  operation: Extract<SequenceEditPrevisIntent['operation'], {kind: 'previs-create'}>): PrevisPlan {
  if (!isUuid(operation.nodeId)) invalid('预演节点 ID 无效');
  if (store.db.prepare('SELECT 1 FROM project.shots WHERE id=?').get(operation.nodeId) !== undefined
    || store.db.prepare('SELECT 1 FROM project.nodes WHERE id=?').get(operation.nodeId) !== undefined) {
    invalid('预演节点 ID 已被占用', {nodeId: operation.nodeId});
  }
  if (count(store, `SELECT count(*) AS n FROM project.nodes WHERE projectId=? AND json_valid(data)
    AND json_extract(data,'$.type')='previs'`) >= PREVIS_LIMITS.createsPerProject) {
    throw new AppError('FORMAT5_CAPACITY', '预演节点已达上限', 409, {limit: PREVIS_LIMITS.createsPerProject});
  }
  if (envelope.baseline.targets.length !== 0) invalid('新建预演不携带目标修订');
  if (envelope.impact.nodeIds.length !== 1 || envelope.impact.nodeIds[0] !== operation.nodeId) invalid('新建预演的受影响目标不匹配');
  const value: PrevisNodeRecord = {id: operation.nodeId, projectId: store.projectId, type: 'previs',
    label: operation.label, text: '', position: {x: operation.position.x, y: operation.position.y},
    revision: 1, sceneRevision: 1, scene: defaultPrevisScene(), createdAt: now()};
  if (!isPrevisNodeRecord(value)) invalid('预演节点记录无效');
  return {nodeId: value.id, before: stateDelta([], [nodeEntity(value)]), after: stateDelta([nodeEntity(value)], [])};
}

function planSceneSet(store: ProjectStore, envelope: SequenceEditEnvelope,
  operation: Extract<SequenceEditPrevisIntent['operation'], {kind: 'previs-scene-set'}>): PrevisPlan {
  const current = livePrevisNode(store, operation.nodeId);
  if (current.sceneRevision !== operation.expectedSceneRevision) {
    conflict('预演场景已有新版本，请重新读取后再修改', {entityId: current.id,
      expectedSceneRevision: operation.expectedSceneRevision, currentSceneRevision: current.sceneRevision});
  }
  if (current.revision >= Number.MAX_SAFE_INTEGER || current.sceneRevision >= Number.MAX_SAFE_INTEGER) {
    throw new AppError('FORMAT5_CAPACITY', '预演节点的修订号已达上限', 409, {});
  }
  const observed = envelope.baseline.targets.filter(target => target.kind === 'node' && target.id === current.id);
  const liveRevision = readMioTargetRevision(store.db, store.projectId, 'node', current.id);
  if (observed.length !== 1 || typeof liveRevision !== 'number' || observed[0]!.revision !== liveRevision) {
    conflict('预演节点已被修改，请重新读取');
  }
  if (envelope.impact.nodeIds.length !== 1 || envelope.impact.nodeIds[0] !== current.id) invalid('预演保存的受影响目标不匹配');
  // Exports already validated when they entered the scene stay trusted; only a
  // new image id pays the ownership read.
  const known = new Set(current.scene.keyframes.flatMap(keyframe => keyframe.exports));
  try { assertPrevisSceneExports(store.db, store.projectId, operation.scene, known); }
  catch (error) {
    if (error instanceof AppError && error.code === 'PREVIS_EXPORT_INVALID') {
      invalid('关键帧导出必须是本项目的图片素材', {assetId: (error.details as Row | undefined)?.assetId});
    }
    throw error;
  }
  resolvePrevisSceneSubjects(store, operation.scene);
  const next: PrevisNodeRecord = {...current, scene: operation.scene, revision: current.revision + 1,
    sceneRevision: current.sceneRevision + 1};
  if (!isPrevisNodeRecord(next)) invalid('预演场景记录无效');
  return {nodeId: current.id, before: stateDelta([nodeEntity(current)], []), after: stateDelta([nodeEntity(next)], []),
    prune: {nodeId: current.id, current: current.scene, next: operation.scene}};
}

/** Targets and impact of the intent, read before planning so the envelope and
 * its digest stay stable between preview and commit. */
function targetOf(store: ProjectStore, nodeId: string): SequenceEditExpectedTarget[] {
  const revision = readMioTargetRevision(store.db, store.projectId, 'node', nodeId);
  if (typeof revision !== 'number') invalid('预演节点的修订证据缺失', {nodeId});
  return [{kind: 'node', id: nodeId, revision}];
}
function impactOf(nodeId: string): SequenceEditImpact {
  return {nodeIds: [nodeId], edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [], subtitleCueIds: []};
}

/** Build the shared envelope a UI/MT caller commits through `sequence.commit`.
 * The caller keeps the observed revisions and the pre-allocated node id on
 * retry; nothing here plans twice with different identities. */
export function buildPrevisEnvelope(store: ProjectStore, intent: SequenceEditPrevisIntent,
  options: {readonly requestId: string; readonly actionId: string; readonly epoch: string;
    readonly origin?: 'user' | 'mio';
    readonly historyPosition: number; readonly historyRevision: number}): SequenceEditEnvelope {
  if (!isFormat5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于格式 5 项目。', 409, {reason: 'FORMAT_REQUIRED'});
  const operation = intent.operation;
  const headerState = readFormat5TimelineState(store.db, 'project');
  if (!headerState.header) throw new AppError('PROJECT_INVALID', '项目没有格式 5 时间线', 422, {database: 'project', reason: 'metadata'});
  const header = JSON.parse(headerState.header.raw) as Row;
  const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
  const targets: SequenceEditExpectedTarget[] = operation.kind === 'previs-create'
    ? [] : targetOf(store, operation.nodeId);
  const envelope: SequenceEditEnvelope = {
    contractVersion: SEQUENCE_EDIT_CONTRACT_VERSION, projectId: store.projectId, epoch: options.epoch,
    actionId: options.actionId, requestId: options.requestId, originSide: 'board',
    ...(options.origin === undefined ? {} : {origin: options.origin}),
    filmId: filmRoot(store), intents: [], previsIntent: intent,
    baseline: {contentRevision: readProjectContentStamp(store.db).contentSequence,
      timelineRevision: Number(header.revision ?? 1), syncRevision: Number(sync?.revision ?? 1),
      historyPosition: options.historyPosition, historyRevision: options.historyRevision, targets},
    impact: impactOf(operation.nodeId), allocation: {clips: [], nodes: [], splitClips: [], edges: []},
  };
  if (!isSequenceEditEnvelope(envelope)) invalid('预演动作 envelope 无效');
  return envelope;
}

export interface PrevisPreview {
  readonly envelope: SequenceEditEnvelope;
  readonly planDigest: string;
  readonly warnings: readonly {code: string}[];
}
/** `sequence.preview` half: build the envelope and fail early with the planner's
 * code so the caller sees the same answer preview and commit would give. */
export function previewPrevisAction(store: ProjectStore, input: {
  readonly requestId: string; readonly actionId?: string; readonly origin?: 'user' | 'mio';
  readonly previsIntent: SequenceEditPrevisIntent;
}): PrevisPreview | {ok: false; code: string; ids: readonly string[]} {
  if (!isFormat5(store)) return {ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID', ids: []};
  try {
    const state = prepareSequenceEditHistory(store).state;
    const envelope = buildPrevisEnvelope(store, input.previsIntent, {requestId: input.requestId,
      actionId: input.actionId ?? crypto.randomUUID(), epoch: state.epoch,
      ...(input.origin === undefined ? {} : {origin: input.origin}),
      historyPosition: state.position, historyRevision: state.revision});
    planPrevisAction(store, envelope);
    return {envelope, planDigest: sequenceEditInputDigest(envelope), warnings: []};
  } catch (error) {
    if (error instanceof AppError && error.code.startsWith('SEQUENCE_EDIT_')) {
      return {ok: false, code: error.code, ids: ((error.details as Row | undefined)?.ids as string[] | undefined) ?? []};
    }
    if (error instanceof AppError && error.code === 'FORMAT5_CAPACITY') {
      return {ok: false, code: error.code, ids: []};
    }
    throw error;
  }
}

/** `history13.operation` of one previs envelope. */
export function previsOperationName(envelope: SequenceEditEnvelope): string {
  const intent = envelope.previsIntent;
  if (!intent) throw new TypeError('Not a previs envelope');
  return intent.operation.kind === 'previs-create' ? 'previs.create' : 'previs.scene.set';
}
