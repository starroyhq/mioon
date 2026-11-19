/** SB-b subject cards on the format-5 board.
 *
 * A `subject_card` node stores only `subjectId` and canvas fields; subject and
 * subject-version rows are retained project content. Creating or deleting a
 * card only touches board rows, active bindings (tombstone detach) and their
 * reference edges. Every action is one shared subject intent, applied by
 * `runSequenceSync` in the same transaction and history entry as bindings and
 * board edits. A subject has at most one live card, so card deletion is the
 * board-level "remove this subject from the board" action; deleting the
 * subject-library record itself needs a format-6 archived column.
 */
import {AppError} from '@mioon/contracts';
import {format5EdgeSchema, format5SubjectBindingSchema} from '@mioon/contracts/project-format5';
import type {Format5Edge, Format5SubjectBinding} from '@mioon/contracts/project-format5';
import type {
  SequenceEditBoardDelta, SequenceEditBoardEntity, SequenceEditEnvelope, SequenceEditImpact, SequenceEditStateDelta,
  SequenceEditSubjectIntent, SubjectCardOperation,
} from '@mioon/contracts/sequence-edit';
import {SEQUENCE_EDIT_CONTRACT_VERSION} from '@mioon/contracts/sequence-edit';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import {readFormat5TimelineState} from './project-file/format5-timeline.ts';
import type {ProjectStore} from './project-file/store.ts';
import {planSubjectBindingAction} from './format5-subject-binding.ts';
import type {SubjectBindingPlan} from './format5-subject-binding.ts';

type Row = Record<string, unknown>;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
const now = (): string => new Date().toISOString();
function invalid(message: string): never {throw new AppError('SEQUENCE_EDIT_SUBJECT_BINDING_INVALID', message, 409, {});}
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const parse = (value: unknown): Row => {
  try { const parsed = JSON.parse(String(value)); if (object(parsed)) return parsed; } catch { /* invalid below */ }
  return invalid('画板主体卡内容无效');
};

export type SubjectCardCommand =
  | {readonly kind: 'card-create'; readonly nodeId: string; readonly subjectId: string;
    readonly position: {readonly x: number; readonly y: number}}
  | {readonly kind: 'card-delete'; readonly nodeId: string};

function operationOf(command: SubjectCardCommand): SubjectCardOperation {
  switch (command.kind) {
    case 'card-create': return {kind: 'subject.card.create', nodeId: command.nodeId, subjectId: command.subjectId,
      position: {x: command.position.x, y: command.position.y}};
    case 'card-delete': return {kind: 'subject.card.delete', nodeId: command.nodeId};
  }
}

function subjectExists(store: ProjectStore, subjectId: string): boolean {
  return Boolean(store.db.prepare('SELECT 1 FROM project.subjects WHERE id=? AND projectId=?').get(subjectId, store.projectId));
}
function liveCards(store: ProjectStore, subjectId: string): {id: string; data: Row}[] {
  const rows = store.db.prepare(`SELECT id,data FROM project.nodes WHERE projectId=? AND archivedAt IS NULL
    AND json_valid(data) AND json_extract(data,'$.type')='subject_card' AND json_extract(data,'$.subjectId')=?`)
    .all(store.projectId, subjectId) as Row[];
  return rows.map(row => ({id: String(row.id), data: parse(row.data)}));
}
function cardById(store: ProjectStore, nodeId: string): {id: string; data: Row} {
  const row = store.db.prepare(`SELECT id,data FROM project.nodes WHERE id=? AND projectId=? AND archivedAt IS NULL
    AND json_valid(data) AND json_extract(data,'$.type')='subject_card'`).get(nodeId, store.projectId) as Row | undefined;
  if (!row) invalid('画板主体卡不存在');
  return {id: String(row.id), data: parse(row.data)};
}
export function subjectIdOfCard(store: ProjectStore, card: {data: Row}): string {
  const subjectId = card.data.subjectId;
  if (!isUuid(subjectId) || !subjectExists(store, subjectId)) invalid('画板主体卡的主体不存在');
  return subjectId;
}

interface BindingRow extends Format5SubjectBinding {readonly edgeId: string | null}
function bindingRows(store: ProjectStore, subjectId?: string): BindingRow[] {
  const rows = store.db.prepare(`SELECT id,projectId,shotId,subjectId,role,revision,bindingMode,subjectVersionId,
    reviewedHeadVersionId,createdAt,updatedAt FROM project.subject_bindings WHERE projectId=?
    ${subjectId === undefined ? '' : 'AND subjectId=?'} ORDER BY id`)
    .all(...(subjectId === undefined ? [store.projectId] : [store.projectId, subjectId])) as Row[];
  return rows.map(row => {
    const parsed = format5SubjectBindingSchema.safeParse(row);
    if (!parsed.success) invalid('主体绑定行无效');
    const edge = store.db.prepare(`SELECT id FROM project.edges WHERE projectId=? AND json_valid(data)
      AND json_extract(data,'$.kind')='reference' AND json_extract(data,'$.subjectBindingId')=?`)
      .get(store.projectId, parsed.data.id) as Row | undefined;
    return {...parsed.data, edgeId: edge ? String(edge.id) : null};
  });
}
function edgeRow(store: ProjectStore, edgeId: string): Format5Edge {
  const row = store.db.prepare('SELECT data FROM project.edges WHERE id=? AND projectId=?').get(edgeId, store.projectId) as Row | undefined;
  if (!row) invalid('主体引用边不存在');
  const parsed = format5EdgeSchema.safeParse(parse(row.data));
  if (!parsed.success) invalid('主体引用边内容无效');
  return parsed.data;
}
const detached = (binding: Format5SubjectBinding, at: string): Format5SubjectBinding => ({...binding,
  bindingMode: 'detached', subjectVersionId: null, reviewedHeadVersionId: null, updatedAt: at});

function nodeEntity(row: Row): SequenceEditBoardEntity {
  return {kind: 'node', id: String(row.id), data: row};
}
function edgeEntity(edge: Format5Edge): SequenceEditBoardEntity {
  return {kind: 'edge', id: edge.id, data: edge as unknown as Row};
}
function bindingEntity(binding: Format5SubjectBinding): SequenceEditBoardEntity {
  return {kind: 'subject_binding', id: binding.id, data: {...binding} as unknown as Row};
}
const UNCHANGED_TIMELINE = Object.freeze({clips: [], cues: [], removedClipIds: [], removedCueIds: [],
  baseline: Object.freeze({kind: 'unchanged' as const})});
const stateDelta = (board: SequenceEditBoardDelta): SequenceEditStateDelta => ({board, timeline: UNCHANGED_TIMELINE});

/** Build the preview envelope for one card/subject command. */
export function buildSubjectCardEnvelope(store: ProjectStore, command: SubjectCardCommand,
  options: {readonly requestId: string; readonly actionId: string; readonly epoch: string;
    readonly historyPosition: number; readonly historyRevision: number; readonly origin?: 'user' | 'mio'}): SequenceEditEnvelope {
  if (command.kind === 'card-create' && (!isUuid(command.nodeId) || !isUuid(command.subjectId)
    || !subjectExists(store, command.subjectId))) invalid('主体或卡标识无效');
  const contentRevision = readProjectContentStamp(store.db).contentSequence;
  const state = readFormat5TimelineState(store.db, 'project');
  const header = state.header ? parse(state.header.raw) : {};
  const mainTrack = header.mainTrack as Row | undefined;
  if (!mainTrack || !isUuid(mainTrack.sequenceNodeId)) invalid('时间线缺少顺序根');
  const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
  const operation = operationOf(command);
  let impact: SequenceEditImpact = {nodeIds: [], edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [],
    subtitleCueIds: [], subjectBindingIds: []};
  if (command.kind === 'card-create') impact = {...impact, nodeIds: [command.nodeId]};
  else {
    const card = cardById(store, command.nodeId);
    const subjectId = subjectIdOfCard(store, card);
    const bindings = bindingRows(store, subjectId);
    impact = {...impact, nodeIds: [card.id],
      edgeIds: bindings.map(binding => binding.edgeId).filter((id): id is string => id !== null),
      subjectBindingIds: bindings.map(binding => binding.id)};
  }
  return {
    contractVersion: SEQUENCE_EDIT_CONTRACT_VERSION, projectId: store.projectId, epoch: options.epoch,
    actionId: options.actionId, requestId: options.requestId, originSide: 'board', filmId: String(mainTrack.sequenceNodeId),
    intents: [], subjectIntent: {side: 'board', operation}, ...(options.origin ? {origin: options.origin} : {}),
    baseline: {contentRevision, timelineRevision: Number(header.revision ?? 1),
      syncRevision: Number(sync?.revision ?? 1), historyPosition: options.historyPosition,
      historyRevision: options.historyRevision, targets: []},
    impact, allocation: {clips: [], nodes: [], splitClips: [], edges: []},
  };
}

/** Validate one card/subject intent and plan its board delta. */
export function planSubjectCardAction(store: ProjectStore, envelope: SequenceEditEnvelope): SubjectBindingPlan {
  const intent = envelope.subjectIntent;
  if (!intent || envelope.intents.length !== 0) invalid('主体动作必须且只能携带一个 subject intent');
  const operation = intent.operation;
  if (operation.kind === 'subject-binding') invalid('主体绑定动作由绑定领域处理');
  const at = now();
  if (operation.kind === 'subject.card.create') {
    if (!isUuid(operation.nodeId) || !isUuid(operation.subjectId)) invalid('主体卡标识无效');
    if (!Number.isFinite(operation.position.x) || !Number.isFinite(operation.position.y)) invalid('主体卡位置无效');
    if (!subjectExists(store, operation.subjectId)) invalid('主体不存在');
    if (liveCards(store, operation.subjectId).length) invalid('这个主体已经有一张画板卡');
    if (store.db.prepare('SELECT 1 FROM project.nodes WHERE id=? AND projectId=?').get(operation.nodeId, store.projectId)) invalid('主体卡 ID 已被使用');
    const row: Row = {id: operation.nodeId, projectId: store.projectId, type: 'subject_card',
      subjectId: operation.subjectId, position: {x: operation.position.x, y: operation.position.y}, createdAt: at};
    return {before: stateDelta({writes: [], removals: [nodeEntity(row)]}),
      after: stateDelta({writes: [nodeEntity(row)], removals: []})};
  }
  const card = cardById(store, operation.nodeId);
  const subjectId = subjectIdOfCard(store, card);
  const bindings = bindingRows(store, subjectId);
  const active = bindings.filter(binding => binding.bindingMode !== 'detached');
  const edgeIds = [...new Set(active.map(binding => binding.edgeId).filter((id): id is string => id !== null))];
  const cards = [card];
  if (!active.length && !edgeIds.length) {
    // Deleting a card with no active reference still removes the card row.
  }
  const removedEdges = edgeIds.map(id => edgeEntity(edgeRow(store, id)));
  const beforeWrites: SequenceEditBoardEntity[] = [...cards.map(card => nodeEntity(card.data)),
    ...active.map(binding => bindingEntity(binding)), ...removedEdges];
  const afterWrites: SequenceEditBoardEntity[] = active.map(binding => bindingEntity(detached(binding, at)));
  return {before: stateDelta({writes: beforeWrites, removals: []}),
    after: stateDelta({writes: afterWrites, removals: [...removedEdges, ...cards.map(card => nodeEntity(card.data))]})};
}

/** Route one subject intent to its planner. Binding intents keep SB-a semantics. */
export function planSubjectEditAction(store: ProjectStore, envelope: SequenceEditEnvelope): SubjectBindingPlan {
  const operation = envelope.subjectIntent?.operation;
  if (operation?.kind === 'subject-binding') return planSubjectBindingAction(store, envelope);
  return planSubjectCardAction(store, envelope);
}

// ---------------------------------------------------------------------------
// Read projection for sequence.board.get
// ---------------------------------------------------------------------------
export interface SubjectBoardSubjectVersion {readonly id: string; readonly number: number; readonly assetId: string}
export interface SubjectBoardSubject {
  readonly id: string; readonly name: string; readonly kind: 'character' | 'product' | 'location' | 'look';
  readonly headVersionId: string; readonly headNumber: number; readonly headAssetId: string;
  readonly versions: readonly SubjectBoardSubjectVersion[];
}
export interface SubjectBoardBinding {
  readonly id: string; readonly shotId: string; readonly subjectId: string; readonly role: 'subject' | 'style';
  readonly bindingMode: 'follow' | 'locked' | 'detached'; readonly subjectVersionId: string | null;
  readonly edgeId: string | null;
}
export interface SubjectBoardProjection {
  readonly subjects: readonly SubjectBoardSubject[];
  readonly bindings: readonly SubjectBoardBinding[];
}
export function readSubjectCardProjection(store: ProjectStore): SubjectBoardProjection {
  const subjects = store.db.prepare('SELECT id,name,kind,headVersionId FROM project.subjects WHERE projectId=? ORDER BY id')
    .all(store.projectId) as Row[];
  const subjectRows = subjects.map(row => {
    const head = store.db.prepare('SELECT id,number,assetId FROM project.subject_versions WHERE id=? AND subjectId=? AND projectId=?')
      .get(String(row.headVersionId), String(row.id), store.projectId) as Row | undefined;
    if (!head) invalid('主体头像版本不存在');
    return {id: String(row.id), name: String(row.name), kind: String(row.kind) as SubjectBoardSubject['kind'],
      headVersionId: String(row.headVersionId), headNumber: Number(head.number), headAssetId: String(head.assetId),
      versions: [] as SubjectBoardSubjectVersion[]};
  });
  const known = new Map(subjectRows.map(row => [row.id, row]));
  const bindings = bindingRows(store);
  const referenced = new Set([...bindings.map(binding => binding.subjectId),
    ...(store.db.prepare(`SELECT DISTINCT json_extract(data,'$.subjectId') AS subjectId FROM project.nodes WHERE projectId=?
      AND archivedAt IS NULL AND json_valid(data) AND json_extract(data,'$.type')='subject_card'`)
      .all(store.projectId) as Row[]).map(row => String(row.subjectId))]);
  for (const subjectId of referenced) {
    const subject = known.get(subjectId);
    if (!subject) continue;
    const versions = store.db.prepare(`SELECT id,number,assetId FROM project.subject_versions
      WHERE projectId=? AND subjectId=? ORDER BY number`).all(store.projectId, subjectId) as Row[];
    (subject.versions as SubjectBoardSubjectVersion[]).push(...versions.map(version => ({id: String(version.id),
      number: Number(version.number), assetId: String(version.assetId)})));
  }
  return {subjects: subjectRows, bindings: bindings.map(binding => ({id: binding.id, shotId: binding.shotId,
    subjectId: binding.subjectId, role: binding.role, bindingMode: binding.bindingMode,
    subjectVersionId: binding.subjectVersionId, edgeId: binding.edgeId}))};
}

/** Delegating planner type used by the sync transaction. */
export type SubjectEditPlanner = (store: ProjectStore, envelope: SequenceEditEnvelope) => SubjectBindingPlan;
