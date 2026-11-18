/** Format-5 subject binding domain (SB-a, service layer).
 *
 * Storage owns the three states (`follow` / `locked` / `detached`). This module
 * reads them, freezes generation inputs and plans one subject-binding action as
 * the board half of the shared `sequence-edit` contract. The only write path is
 * `format5-sequence-sync.ts`: it validates the envelope, applies the returned
 * board delta and writes one history-13 undo entry.
 *
 * Tombstone semantics (coordinator 11-18): a binding row is never deleted and
 * its native revision always advances. `before`/`after` patches therefore carry
 * content only; undoing a create writes a `detached` row, undoing a mode change
 * restores the content fields and lets the revision move forward.
 */
import {AppError} from '@mioon/contracts';
import type {Format5Edge, Format5SubjectBinding} from '@mioon/contracts/project-format5';
import {format5EdgeSchema, format5SubjectBindingSchema} from '@mioon/contracts/project-format5';
import type {
  SequenceEditBoardDelta, SequenceEditBoardEntity, SequenceEditEnvelope, SequenceEditExpectedTarget,
  SequenceEditImpact, SequenceEditStateDelta, SequenceEditTimelineDelta, SubjectBindingOperation,
} from '@mioon/contracts/sequence-edit';
import {SEQUENCE_EDIT_CONTRACT_VERSION} from '@mioon/contracts/sequence-edit';
import type {ProjectStore} from './project-file/store.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import {readFormat5TimelineState} from './project-file/format5-timeline.ts';
import {isSubjectVersionHidden} from './subject-variant-visibility.ts';

type Row = Record<string, unknown>;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
const now = (): string => new Date().toISOString();
function invalid(message: string): never {throw new AppError('SEQUENCE_EDIT_SUBJECT_BINDING_INVALID', message, 409, {});}
function conflict(): never {throw new AppError('SEQUENCE_EDIT_REVISION_CONFLICT', '主体绑定已被修改，请重新读取', 409, {});}

export type SubjectBindingMode = 'follow' | 'locked' | 'detached';

export function format5SubjectBindings(store: ProjectStore): boolean {
  return store.db.prepare('PRAGMA project.user_version').get()?.user_version === FORMAT5_PROJECT_SCHEMA_VERSION;
}

function row(store: ProjectStore, sql: string, ...args: (string | number)[]): Row | undefined {
  return store.db.prepare(sql).get(...args) as Row | undefined;
}

function subjectRow(store: ProjectStore, subjectId: string): Row {
  const value = row(store, 'SELECT id,projectId,kind,revision,headVersionId FROM project.subjects WHERE id=? AND projectId=?', subjectId, store.projectId);
  if (!value) throw new AppError('SEQUENCE_EDIT_SUBJECT_BINDING_INVALID', '主体不存在或不属于当前项目', 409, {});
  if (!isUuid(value.id) || typeof value.headVersionId !== 'string') invalid('主体内容无效');
  return value;
}

function subjectVersionRow(store: ProjectStore, versionId: string, subjectId: string): Row {
  const value = row(store, 'SELECT id,projectId,subjectId,number,assetId,data FROM project.subject_versions WHERE id=? AND projectId=? AND subjectId=?', versionId, store.projectId, subjectId);
  if (!value) throw new AppError('SEQUENCE_EDIT_SUBJECT_BINDING_INVALID', '主体版本不存在或不属于该主体', 409, {});
  let data: Row | undefined;
  try { data = JSON.parse(String(value.data)) as Row; } catch { invalid('主体版本内容无效'); }
  if (!data) throw new AppError('SEQUENCE_EDIT_SUBJECT_BINDING_INVALID', '主体版本内容无效', 409, {});
  if (data.id !== value.id || data.subjectId !== value.subjectId || data.projectId !== store.projectId) invalid('主体版本内容无效');
  return {...value, data};
}

function shotRow(store: ProjectStore, shotId: string): Row {
  const value = row(store, 'SELECT id,projectId,archivedAt FROM project.shots WHERE id=? AND projectId=?', shotId, store.projectId);
  if (!value) throw new AppError('SEQUENCE_EDIT_SUBJECT_BINDING_INVALID', '镜头不存在或不属于当前项目', 409, {});
  return value;
}

function cardNode(store: ProjectStore, subjectId: string): Row {
  const rows = store.db.prepare(`SELECT id,projectId,data FROM project.nodes WHERE projectId=? AND json_valid(data)
    AND json_extract(data,'$.type')='subject_card' AND json_extract(data,'$.subjectId')=? AND archivedAt IS NULL`).all(store.projectId, subjectId) as Row[];
  if (rows.length !== 1) invalid('画板上没有唯一的主体卡');
  return rows[0]!;
}

function bindingByTriple(store: ProjectStore, shotId: string, subjectId: string, role: 'subject' | 'style'): Format5SubjectBinding | null {
  const value = row(store, `SELECT id,projectId,shotId,subjectId,role,revision,bindingMode,subjectVersionId,
    reviewedHeadVersionId,createdAt,updatedAt FROM project.subject_bindings
    WHERE projectId=? AND shotId=? AND subjectId=? AND role=?`, store.projectId, shotId, subjectId, role);
  if (!value) return null;
  const parsed = format5SubjectBindingSchema.safeParse(value);
  if (!parsed.success) invalid('主体绑定行无效');
  return parsed.data;
}

export function readSubjectBinding(store: ProjectStore, bindingId: string): Format5SubjectBinding | null {
  const value = row(store, `SELECT id,projectId,shotId,subjectId,role,revision,bindingMode,subjectVersionId,
    reviewedHeadVersionId,createdAt,updatedAt FROM project.subject_bindings WHERE id=? AND projectId=?`, bindingId, store.projectId);
  if (!value) return null;
  const parsed = format5SubjectBindingSchema.safeParse(value);
  if (!parsed.success) invalid('主体绑定行无效');
  return parsed.data;
}

export function readSubjectBindings(store: ProjectStore, filter: {readonly shotId?: string; readonly subjectId?: string}): readonly Format5SubjectBinding[] {
  if ((filter.shotId === undefined) === (filter.subjectId === undefined)) throw new TypeError('Exactly one binding filter is required');
  const column = filter.shotId !== undefined ? 'shotId' : 'subjectId';
  const filterValue = filter.shotId ?? filter.subjectId;
  if (filterValue === undefined) throw new TypeError('A binding filter value is required');
  const values = store.db.prepare(`SELECT id,projectId,shotId,subjectId,role,revision,bindingMode,subjectVersionId,
    reviewedHeadVersionId,createdAt,updatedAt FROM project.subject_bindings WHERE projectId=? AND ${column}=? ORDER BY id`)
    .all(store.projectId, filterValue) as Row[];
  return values.map(value => {
    const parsed = format5SubjectBindingSchema.safeParse(value);
    if (!parsed.success) invalid('主体绑定行无效');
    return parsed.data;
  });
}

function bindingEdge(store: ProjectStore, bindingId: string): Format5Edge | null {
  const value = row(store, `SELECT id,projectId,data FROM project.edges WHERE projectId=?
    AND json_valid(data) AND json_extract(data,'$.kind')='reference' AND json_extract(data,'$.subjectBindingId')=?`, store.projectId, bindingId);
  if (!value) return null;
  let data: unknown;
  try { data = JSON.parse(String(value.data)); } catch { invalid('主体引用边内容无效'); }
  const parsed = format5EdgeSchema.safeParse(data);
  if (!parsed.success) invalid('主体引用边内容无效');
  return parsed.data;
}

const roleOf = (kind: unknown): 'subject' | 'style' => kind === 'look' ? 'style' : 'subject';

function assertRole(subject: Row, role: 'subject' | 'style'): void {
  if (role !== roleOf(subject.kind)) invalid('主体角色与主体类型不匹配');
}

function appliedVersion(store: ProjectStore, subjectId: string, versionId: string | null, mode: SubjectBindingMode): string | null {
  if (mode !== 'locked') {
    if (versionId !== null) invalid('跟随或解绑的绑定不能记录主体版本');
    return null;
  }
  if (versionId === null) invalid('锁定绑定必须记录主体版本');
  subjectVersionRow(store, versionId, subjectId);
  if (isSubjectVersionHidden(store.db, versionId)) {
    throw new AppError('SEQUENCE_EDIT_SUBJECT_VERSION_HIDDEN', '这个主体版本属于已撤销的补角度批次，已隐藏', 409, {});
  }
  return versionId;
}

function assertActiveLimit(store: ProjectStore, shotId: string, exceptId?: string): void {
  const values = store.db.prepare(`SELECT id FROM project.subject_bindings WHERE projectId=? AND shotId=?
    AND bindingMode IN ('follow','locked')`).all(store.projectId, shotId) as Row[];
  if (values.filter(value => value.id !== exceptId).length >= 8) {
    throw new AppError('SEQUENCE_EDIT_SUBJECT_BINDING_LIMIT', '每个镜头最多绑定 8 个主体或风格', 409, {limit: 8});
  }
}

function bindingTargetRevision(store: ProjectStore, bindingId: string): number {
  const value = row(store, `SELECT revision FROM project.agent_task_target_revisions_v2
    WHERE projectId=? AND kind='subject_binding' AND targetId=?`, store.projectId, bindingId);
  return value && Number.isSafeInteger(value.revision) ? Number(value.revision) : 0;
}

/** Deterministic board entities use JSON content only; the transaction owns the
 * native revision. */
function bindingEntity(value: Format5SubjectBinding): SequenceEditBoardEntity {
  return {kind: 'subject_binding', id: value.id, data: {...value}};
}
function edgeEntity(value: Format5Edge): SequenceEditBoardEntity {
  return {kind: 'edge', id: value.id, data: value as unknown as Row};
}

function filmRoot(store: ProjectStore): string {
  const state = readFormat5TimelineState(store.db, 'project');
  if (!state.header) throw new AppError('PROJECT_INVALID', '项目没有格式 5 时间线', 422, {database: 'project', reason: 'metadata'});
  const header = JSON.parse(state.header.raw) as Row;
  const mainTrack = header.mainTrack as Row | undefined;
  if (!mainTrack || typeof mainTrack.sequenceNodeId !== 'string' || !isUuid(mainTrack.sequenceNodeId)) invalid('时间线缺少顺序根');
  return mainTrack.sequenceNodeId;
}

/** One requested binding action. `bindingId` is allocated (and retried) by the
 * caller; the reference edge id comes from `allocation.edges` for create and
 * restore, exactly like every other pre-allocated edge identity. */
export type SubjectBindingCommand =
  | {readonly kind: 'create'; readonly bindingId: string; readonly shotId: string; readonly subjectId: string; readonly role: 'subject' | 'style'}
  | {readonly kind: 'set-mode'; readonly bindingId: string; readonly bindingMode: 'follow' | 'locked'; readonly subjectVersionId: string | null}
  | {readonly kind: 'detach'; readonly bindingId: string}
  | {readonly kind: 'restore'; readonly bindingId: string; readonly bindingMode: 'follow' | 'locked'; readonly subjectVersionId: string | null};

function operationOf(command: SubjectBindingCommand): SubjectBindingOperation {
  switch (command.kind) {
    case 'create': return {kind: 'subject-binding', edit: {kind: 'create', bindingId: command.bindingId,
      shotId: command.shotId, subjectId: command.subjectId, role: command.role}};
    case 'set-mode': return {kind: 'subject-binding', edit: {kind: 'set-mode', bindingId: command.bindingId,
      bindingMode: command.bindingMode, subjectVersionId: command.subjectVersionId}};
    case 'detach': return {kind: 'subject-binding', edit: {kind: 'detach', bindingId: command.bindingId}};
    case 'restore': return {kind: 'subject-binding', edit: {kind: 'restore', bindingId: command.bindingId,
      bindingMode: command.bindingMode, subjectVersionId: command.subjectVersionId}};
  }
}

/** Build the envelope a caller commits through `runSequenceSync`. The caller
 * must keep the same envelope (including the pre-allocated edge id) on retry. */
export function buildSubjectBindingEnvelope(store: ProjectStore, command: SubjectBindingCommand,
  options: {readonly requestId: string; readonly actionId: string; readonly epoch: string;
    readonly historyPosition: number; readonly historyRevision: number; readonly edgeId: string}): SequenceEditEnvelope {
  if (!format5SubjectBindings(store)) throw new TypeError('Subject binding actions require an admitted format-5 project');
  const existing = command.kind === 'create' ? null : readSubjectBinding(store, command.bindingId);
  if (command.kind !== 'create' && !existing) invalid('主体绑定不存在');
  const contentRevision = readProjectContentStamp(store.db).contentSequence;
  const state = readFormat5TimelineState(store.db, 'project');
  const header = state.header ? JSON.parse(state.header.raw) as Row : {};
  const sync = row(store, 'SELECT revision FROM project.sequence_sync_state');
  const targets: SequenceEditExpectedTarget[] = existing
    ? [{kind: 'subject_binding', id: existing.id, revision: bindingTargetRevision(store, existing.id)}] : [];
  const edgeIds = command.kind === 'create' || command.kind === 'restore' ? [options.edgeId] : [];
  const impact: SequenceEditImpact = {nodeIds: [], edgeIds, mainTrackClipIds: [], otherTrackItemIds: [],
    subtitleCueIds: [], subjectBindingIds: [command.bindingId]};
  const shotId = command.kind === 'create' ? command.shotId : existing?.shotId;
  const card = shotId ? row(store, `SELECT id FROM project.nodes WHERE projectId=? AND json_valid(data)
    AND json_extract(data,'$.type')='subject_card' AND json_extract(data,'$.subjectId')=?
    AND archivedAt IS NULL`, store.projectId, command.kind === 'create' ? command.subjectId : existing!.subjectId) : undefined;
  return {
    contractVersion: SEQUENCE_EDIT_CONTRACT_VERSION, projectId: store.projectId, epoch: options.epoch,
    actionId: options.actionId, requestId: options.requestId, originSide: 'board', filmId: filmRoot(store),
    intents: [], subjectIntent: {side: 'board', operation: operationOf(command)},
    baseline: {contentRevision, timelineRevision: Number(header.revision ?? 1),
      syncRevision: Number(sync?.revision ?? 1), historyPosition: options.historyPosition,
      historyRevision: options.historyRevision, targets},
    impact,
    allocation: {clips: [], nodes: [], splitClips: [], edges: card?.id && shotId
      ? [{id: options.edgeId, fromId: String(card.id), toId: shotId}] : []},
  };
}

export interface SubjectBindingPlan {
  readonly before: SequenceEditStateDelta;
  readonly after: SequenceEditStateDelta;
}

const UNCHANGED_TIMELINE: SequenceEditTimelineDelta = Object.freeze({clips: [], cues: [], removedClipIds: [],
  removedCueIds: [], baseline: Object.freeze({kind: 'unchanged' as const})});
const stateDelta = (board: SequenceEditBoardDelta): SequenceEditStateDelta => ({board, timeline: UNCHANGED_TIMELINE});

/** Validate one subject intent against the live project and plan the board delta
 * (binding content rows and reference edge). The transaction owns the native
 * revision: writes are applied as current + 1, removals never carry bindings. */
export function planSubjectBindingAction(store: ProjectStore, envelope: SequenceEditEnvelope): SubjectBindingPlan {
  const intent = envelope.subjectIntent;
  if (!intent || envelope.intents.length !== 0) invalid('主体动作必须且只能携带一个 subject intent');
  const edit = intent.operation.edit;
  const target = (bindingId: string): void => {
    if (!envelope.baseline.targets.some(item => item.kind === 'subject_binding' && item.id === bindingId
      && item.revision === bindingTargetRevision(store, bindingId))) conflict();
  };
  if (edit.kind === 'create') {
    if (!isUuid(edit.bindingId) || !isUuid(edit.shotId) || !isUuid(edit.subjectId)) invalid('主体绑定标识无效');
    if (bindingByTriple(store, edit.shotId, edit.subjectId, edit.role)) invalid('该主体已绑定此镜头和角色，不能重复新建');
    const shot = shotRow(store, edit.shotId);
    if (shot.archivedAt !== null && shot.archivedAt !== undefined) invalid('镜头已归档');
    const subject = subjectRow(store, edit.subjectId);
    assertRole(subject, edit.role);
    assertActiveLimit(store, edit.shotId);
    const card = cardNode(store, edit.subjectId);
    const allocation = envelope.allocation.edges.filter(edge => edge.toId === edit.shotId);
    if (allocation.length !== 1) invalid('新建主体绑定需要预分配的引用边 ID');
    const edge = allocation[0]!;
    if (edge.fromId !== card.id || !isUuid(edge.id)) invalid('预分配引用边与主体卡不匹配');
    if (row(store, 'SELECT 1 FROM project.edges WHERE id=? AND projectId=?', edge.id, store.projectId)) invalid('引用边 ID 已被使用');
    const timestamp = now();
    const value: Format5SubjectBinding = {id: edit.bindingId, projectId: store.projectId, shotId: edit.shotId,
      subjectId: edit.subjectId, role: edit.role, revision: 1, bindingMode: 'follow', subjectVersionId: null,
      reviewedHeadVersionId: null, createdAt: timestamp, updatedAt: timestamp};
    const parsed = format5SubjectBindingSchema.safeParse(value);
    if (!parsed.success) invalid('主体绑定行无效');
    const reference: Format5Edge = {id: edge.id, projectId: store.projectId, source: String(card.id), target: edit.shotId,
      kind: 'reference', role: edit.role === 'style' ? 'style_reference' : 'subject_reference',
      subjectBindingId: edit.bindingId, createdAt: timestamp};
    if (!format5EdgeSchema.safeParse(reference).success) invalid('主体引用边无效');
    return {before: stateDelta({writes: [bindingEntity({...value, bindingMode: 'detached'})], removals: [edgeEntity(reference)]}),
      after: stateDelta({writes: [edgeEntity(reference), bindingEntity(value)], removals: []})};
  }
  const existing = readSubjectBinding(store, edit.bindingId);
  if (!existing) invalid('主体绑定不存在');
  target(existing.id);
  const subject = subjectRow(store, existing.subjectId);
  if (edit.kind === 'set-mode') {
    if (existing.bindingMode === 'detached') invalid('解绑的绑定只能用恢复操作');
    assertRole(subject, existing.role);
    const versionId = appliedVersion(store, existing.subjectId, edit.subjectVersionId, edit.bindingMode);
    const next: Format5SubjectBinding = {...existing, bindingMode: edit.bindingMode, subjectVersionId: versionId, updatedAt: now()};
    return {before: stateDelta({writes: [bindingEntity(existing)], removals: []}),
      after: stateDelta({writes: [bindingEntity(next)], removals: []})};
  }
  if (edit.kind === 'detach') {
    if (existing.bindingMode === 'detached') invalid('绑定已经解绑');
    const edge = bindingEdge(store, existing.id);
    const next: Format5SubjectBinding = {...existing, bindingMode: 'detached', subjectVersionId: null,
      reviewedHeadVersionId: null, updatedAt: now()};
    return {before: stateDelta({writes: [bindingEntity(existing), ...(edge ? [edgeEntity(edge)] : [])], removals: []}),
      after: stateDelta({writes: [bindingEntity(next)], removals: edge ? [edgeEntity(edge)] : []})};
  }
  if (existing.bindingMode !== 'detached') invalid('只有解绑的绑定可以恢复');
  assertRole(subject, existing.role);
  const versionId = appliedVersion(store, existing.subjectId, edit.subjectVersionId, edit.bindingMode);
  const card = cardNode(store, existing.subjectId);
  const allocation = envelope.allocation.edges.filter(edge => edge.toId === existing.shotId);
  if (allocation.length !== 1) invalid('恢复主体绑定需要预分配的引用边 ID');
  const edge = allocation[0]!;
  if (edge.fromId !== card.id || !isUuid(edge.id)) invalid('预分配引用边与主体卡不匹配');
  if (row(store, 'SELECT 1 FROM project.edges WHERE id=? AND projectId=?', edge.id, store.projectId)) invalid('引用边 ID 已被使用');
  const timestamp = now();
  const reference: Format5Edge = {id: edge.id, projectId: store.projectId, source: String(card.id), target: existing.shotId,
    kind: 'reference', role: existing.role === 'style' ? 'style_reference' : 'subject_reference',
    subjectBindingId: existing.id, createdAt: timestamp};
  const next: Format5SubjectBinding = {...existing, bindingMode: edit.bindingMode, subjectVersionId: versionId,
    reviewedHeadVersionId: null, updatedAt: timestamp};
  return {before: stateDelta({writes: [bindingEntity(existing)], removals: [edgeEntity(reference)]}),
    after: stateDelta({writes: [edgeEntity(reference), bindingEntity(next)], removals: []})};
}

/** Stable action operation name for one envelope. */
export function subjectBindingOperationName(envelope: SequenceEditEnvelope): string {
  if (!envelope.subjectIntent) throw new TypeError('Not a subject binding envelope');
  const edit = envelope.subjectIntent.operation.edit;
  return `subject.binding.${edit.kind === 'set-mode' ? 'set-mode' : edit.kind}`;
}

// ---------------------------------------------------------------------------
// Generation inputs, previs references and deletion impact lists
// ---------------------------------------------------------------------------

export interface FrozenSubjectGenerationInput {
  readonly bindingId: string;
  readonly subjectId: string;
  readonly subjectVersionId: string;
  readonly role: 'subject' | 'style';
  readonly mode: 'follow' | 'locked';
  readonly sha256: string;
  readonly mimeType: string;
}

/** Resolve each active binding of the given shots for one generation request.
 * `follow` snapshots the current head once, so a later subject update only
 * affects the next job; `locked` keeps the applied version. */
export function resolveGenerationSubjectInputs(store: ProjectStore, shotIds: readonly string[]): readonly FrozenSubjectGenerationInput[] {
  if (!format5SubjectBindings(store)) throw new TypeError('Generation subject inputs require an admitted format-5 project');
  const result: FrozenSubjectGenerationInput[] = [];
  for (const shotId of [...new Set(shotIds)]) for (const binding of readSubjectBindings(store, {shotId})) {
    if (binding.bindingMode === 'detached') continue;
    const subject = subjectRow(store, binding.subjectId);
    const versionId = binding.bindingMode === 'locked' ? binding.subjectVersionId! : String(subject.headVersionId);
    const version = subjectVersionRow(store, versionId, binding.subjectId);
    const data = version.data as Row;
    if (typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(data.sha256)
      || !['image/png', 'image/jpeg', 'image/webp'].includes(String(data.mimeType))) invalid('主体版本缺少可信图片指纹');
    result.push({bindingId: binding.id, subjectId: binding.subjectId, subjectVersionId: versionId,
      role: binding.role, mode: binding.bindingMode, sha256: data.sha256, mimeType: String(data.mimeType)});
  }
  return result.sort((a, b) => a.bindingId.localeCompare(b.bindingId));
}

/**
 * Previs mannequin/prop subject reference (`{subjectId, subjectVersionId?}`).
 * The previs scene contract fields are added by the previs card together with
 * its Mio tool schema/fingerprint update; this resolver is the service seam the
 * scene save path calls. A null version keeps follow, a version is locked.
 */
export interface PrevisSubjectReference {
  readonly subjectId: string;
  readonly subjectVersionId: string | null;
}
export function resolvePrevisSubjectReference(store: ProjectStore, reference: PrevisSubjectReference):
  {readonly subjectId: string; readonly subjectVersionId: string; readonly mode: 'follow' | 'locked'; readonly sha256: string; readonly mimeType: string} {
  if (!format5SubjectBindings(store)) throw new TypeError('Previs subject references require an admitted format-5 project');
  const subject = subjectRow(store, reference.subjectId);
  const mode: 'follow' | 'locked' = reference.subjectVersionId === null ? 'follow' : 'locked';
  const version = subjectVersionRow(store, reference.subjectVersionId ?? String(subject.headVersionId), reference.subjectId);
  const data = version.data as Row;
  if (typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(data.sha256)) invalid('主体版本缺少可信图片指纹');
  return {subjectId: reference.subjectId, subjectVersionId: String(version.id), mode,
    sha256: data.sha256, mimeType: String(data.mimeType)};
}

/** Service-layer impact list for deletion confirmations (no write happens). */
export interface SubjectDeletionImpact {
  readonly subjectIds: readonly string[];
  readonly cardNodeIds: readonly string[];
  readonly bindingIds: readonly string[];
  readonly activeBindingIds: readonly string[];
  readonly detachedBindingIds: readonly string[];
  readonly shotIds: readonly string[];
  readonly edgeIds: readonly string[];
}
export function subjectCardDeletionImpact(store: ProjectStore, cardNodeId: string): SubjectDeletionImpact {
  const card = row(store, 'SELECT id,data FROM project.nodes WHERE id=? AND projectId=?', cardNodeId, store.projectId);
  if (!card) invalid('主体卡不存在');
  let subjectId: string;
  try { subjectId = String((JSON.parse(String(card.data)) as Row).subjectId); } catch { invalid('主体卡内容无效'); }
  if (!isUuid(subjectId)) invalid('主体卡内容无效');
  const bindings = readSubjectBindings(store, {subjectId});
  return {subjectIds: [subjectId], cardNodeIds: [cardNodeId], bindingIds: bindings.map(item => item.id).sort(),
    activeBindingIds: bindings.filter(item => item.bindingMode !== 'detached').map(item => item.id).sort(),
    detachedBindingIds: bindings.filter(item => item.bindingMode === 'detached').map(item => item.id).sort(),
    shotIds: [...new Set(bindings.map(item => item.shotId))].sort(),
    edgeIds: bindings.map(item => bindingEdge(store, item.id)?.id).filter((id): id is string => typeof id === 'string').sort()};
}
export function subjectDeletionImpact(store: ProjectStore, subjectId: string): SubjectDeletionImpact {
  subjectRow(store, subjectId);
  const cards = store.db.prepare(`SELECT id FROM project.nodes WHERE projectId=? AND json_valid(data)
    AND json_extract(data,'$.type')='subject_card' AND json_extract(data,'$.subjectId')=? AND archivedAt IS NULL`)
    .all(store.projectId, subjectId) as Row[];
  const bindings = readSubjectBindings(store, {subjectId});
  return {subjectIds: [subjectId], cardNodeIds: cards.map(card => String(card.id)).sort(),
    bindingIds: bindings.map(item => item.id).sort(),
    activeBindingIds: bindings.filter(item => item.bindingMode !== 'detached').map(item => item.id).sort(),
    detachedBindingIds: bindings.filter(item => item.bindingMode === 'detached').map(item => item.id).sort(),
    shotIds: [...new Set(bindings.map(item => item.shotId))].sort(),
    edgeIds: bindings.map(item => bindingEdge(store, item.id)?.id).filter((id): id is string => typeof id === 'string').sort()};
}
