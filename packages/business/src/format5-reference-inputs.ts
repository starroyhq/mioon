/** Format-5 reference lines and multi-reference generation inputs (RI-a).
 *
 * Two responsibilities, both read-only apart from the unified `sequence-edit`
 * write path this module plans for:
 *
 * 1. Material reference lines (`reference.attach` / `reference.role.set` /
 *    `reference.detach`). A reference edge is a board object; the whole row is
 *    planned as `SequenceEditBoardDelta` so undo/redo restores identity, role,
 *    source asset and order in one user step. Subject-card connectors are NOT
 *    material references: SB's `subjectIntent` owns the binding row + edge pair,
 *    so this module rejects that source type instead of duplicating the write.
 *    Every first/last-frame write also refreshes the legacy
 *    `shots.referenceAssetIds` / `shots.lastFrameAssetId` projection inside the
 *    same transaction (P5 §2.1); format-5 generation itself reads the edges.
 *
 * 2. Generation input planning. Board references, active subject bindings and
 *    the subjects one connected previs scene names are matched against one
 *    exact video input profile (GR support matrix): first/last frames, ordered
 *    multi-reference images (with a primary image), previs composition,
 *    reference audio and the mannequin/prop subject references of a previs
 *    scene (a look subject is a style reference, everything else is a subject
 *    reference, each one counted once with the shot's direct binding winning).
 *    Inputs the selected service does not accept are reported with a stable
 *    reason instead of being silently dropped; the caller records the actual
 *    request shape and freezes the assets, hashes, subject versions and roles
 *    into the job snapshot (and therefore the immutable generation version
 *    provenance). Late board changes only affect the next job.
 */
import {AppError} from '../../contracts/src/app-error.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {Format5Edge} from '../../contracts/src/project-format5.ts';
import {FORMAT5_INPUT_LIMITS, format5EdgeSchema} from '../../contracts/src/project-format5.ts';
import type {ChainReferenceRole, ReferenceSourceKind} from '../../contracts/src/board-sequence.ts';
import {FRAME_REFERENCE_ROLES, REFERENCE_SOURCE_ROLES, defaultReferenceRole, referenceRoleAllowed} from '../../contracts/src/board-sequence.ts';
import type {SequenceGenerationInputEntryView, SequenceGenerationInputMode, SequenceGenerationInputStatus,
  SequenceGenerationInputView} from '../../contracts/src/sequence-inspection.ts';
import {FORMAT5_MOCK_INPUT_CONFIGURATION_REVISION,FORMAT5_MOCK_INPUT_CONNECTION_ID,FORMAT5_MOCK_INPUT_MODEL_ENTRY_ID} from '../../contracts/src/sequence-inspection.ts';
import type {PrevisNodeRecord} from '../../contracts/src/previs.ts';
import {PREVIS_LIMITS, isPrevisNodeRecord} from '../../contracts/src/previs.ts';
import type {
  ReferenceEdgeOperation, SequenceEditBoardDelta, SequenceEditBoardEntity, SequenceEditEnvelope,
  SequenceEditExpectedTarget, SequenceEditImpact, SequenceEditStateDelta, SequenceEditTimelineDelta,
} from '../../contracts/src/sequence-edit.ts';
import {SEQUENCE_EDIT_CONTRACT_VERSION} from '../../contracts/src/sequence-edit.ts';
import type {VideoExecutionBinding} from '../../contracts/src/video-providers.ts';
import {isSeedance25Binding, isWan30Binding, videoInputProfile} from '../../contracts/src/video-providers.ts';
import type {WanVideoInput} from '../../contracts/src/wan-video.ts';
import type {ProjectStore} from './project-file/store.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import {readFormat5TimelineState} from './project-file/format5-timeline.ts';
import {canvasActiveEdgeCondition, isCanvasArchived} from './canvas-active.ts';
import {readGenerationAsset} from './generation-inputs.ts';
import {readPrevisOutputSource} from './previs-output-ownership.ts';
import {resolveGenerationSubjectInputs} from './format5-subject-binding.ts';
import {resolvePrevisSceneSubjects} from './format5-previs.ts';
import {format5DialogueView, planFormat5DialogueGeneration} from './format5-dialogue-generation.ts';

type Row = Record<string, any>;
type ReferenceEdge = Extract<Format5Edge, {readonly kind: 'reference'}>;
type MaterialReferenceEdge = Extract<Format5Edge, {readonly kind: 'reference'; readonly sourceAssetId: string}>;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
const now = (): string => new Date().toISOString();

export function format5ReferenceInputs(store: ProjectStore): boolean {
  return Number(store.db.prepare('PRAGMA project.user_version').get()?.user_version) === FORMAT5_PROJECT_SCHEMA_VERSION;
}

/** Every reference refusal gets a stable reason for the UI. The map keeps the
 * internal messages single-sourced while the public response only carries a
 * bounded reason code. */
const referenceInvalidReasons: Readonly<Record<string, string>> = {
  '主体不存在或不属于当前项目': 'SUBJECT_MISSING',
  '主体卡连线走主体绑定（subject.binding）动作，不重复建引用边': 'SUBJECT_BINDING_REQUIRED',
  '主体引用边走主体绑定动作': 'SUBJECT_BINDING_REQUIRED',
  '主体版本缺少素材': 'SUBJECT_VERSION_MISSING',
  '先把尾帧改成其他角色或断开，首帧才能退出': 'FIRST_FRAME_BLOCKED_BY_LAST',
  '先断开尾帧，再断开首帧': 'LAST_FRAME_DETACH_FIRST',
  '参考素材类型与连线用途不符': 'ASSET_TYPE_MISMATCH',
  '参考素材缺少可信指纹': 'ASSET_UNVERIFIED',
  '尾帧需要先连一个首帧': 'LAST_FRAME_REQUIRES_FIRST',
  '引用动作必须且只能携带一个 reference intent': 'REFERENCE_INVALID',
  '引用线 ID 已被使用': 'EDGE_ID_CONFLICT',
  '引用线不存在': 'EDGE_MISSING',
  '引用线不属于这个镜头': 'EDGE_TARGET_MISMATCH',
  '引用线内容无效': 'EDGE_INVALID',
  '引用线已删除，请先恢复': 'EDGE_ARCHIVED',
  '引用线来源已不可用': 'SOURCE_TYPE_INVALID',
  '引用线标识无效': 'REFERENCE_INVALID',
  '引用线缺少素材身份': 'EDGE_INVALID',
  '引用线顺序清单与当前连线不一致，请重新读取': 'ORDER_SET_MISMATCH',
  '引用线顺序清单无效': 'ORDER_SET_MISMATCH',
  '新建引用线需要预分配的连线 ID': 'EDGE_ALLOCATION_REQUIRED',
  '时间线缺少顺序根': 'TIMELINE_ROOT_MISSING',
  '画板节点不存在或不属于当前项目': 'NODE_MISSING',
  '画板节点内容无效': 'NODE_INVALID',
  '画板节点已删除，请先恢复': 'NODE_ARCHIVED',
  '画板节点类型不能作为引用线来源': 'SOURCE_TYPE_INVALID',
  '素材节点还没有可用的托管素材': 'ASSET_NOT_READY',
  '这个素材类型不能用所选引用角色': 'ROLE_NOT_ALLOWED',
  '镜头不存在或不属于当前项目': 'SHOT_MISSING',
  '镜头内容无效': 'SHOT_INVALID',
  '镜头已删除，请先恢复': 'SHOT_ARCHIVED',
  '预演节点记录无法验证': 'PREVIS_INVALID',
  '预演输出缺少可信指纹': 'PREVIS_OUTPUT_UNVERIFIED',
  '预演还没有可核验的输出图，请先生成并保存预演画面': 'PREVIS_OUTPUT_REQUIRED',
};
function referenceInvalid(message: string, details: Row = {}): never {
  const explicit = typeof details.reason === 'string' && details.reason ? details.reason : undefined;
  const reason = explicit ?? referenceInvalidReasons[message];
  throw new AppError('SEQUENCE_EDIT_REFERENCE_INVALID', message, 409, {...details, ...(reason ? {reason} : {})});
}
function conflict(message: string, details: Row = {}): never {
  throw new AppError('SEQUENCE_EDIT_REVISION_CONFLICT', message, 409, details);
}

function row(store: ProjectStore, sql: string, ...args: (string | number)[]): Row | undefined {
  return store.db.prepare(sql).get(...args) as Row | undefined;
}

function targetRevision(store: ProjectStore, kind: 'shot' | 'edge', id: string): number {
  const value = row(store, `SELECT revision FROM project.agent_task_target_revisions_v2
    WHERE projectId=? AND kind=? AND targetId=?`, store.projectId, kind, id);
  return value && Number.isSafeInteger(value.revision) ? Number(value.revision) : 0;
}

function filmRoot(store: ProjectStore): string {
  const state = readFormat5TimelineState(store.db, 'project');
  if (!state.header) throw new AppError('PROJECT_INVALID', '项目没有格式 5 时间线', 422, {database: 'project', reason: 'metadata'});
  const header = JSON.parse(state.header.raw) as Row;
  const mainTrack = header.mainTrack as Row | undefined;
  if (!mainTrack || !isUuid(mainTrack.sequenceNodeId)) referenceInvalid('时间线缺少顺序根');
  return String(mainTrack.sequenceNodeId);
}

// ---------------------------------------------------------------------------
// Source nodes, default roles and the persisted reference edge
// ---------------------------------------------------------------------------

/** The role table is shared with the browser (`board-sequence.ts`) so the role
 * menu, defaults and the generation plan can never disagree. Re-exported here to
 * keep this module's existing service imports stable. */
export type {ReferenceSourceKind} from '../../contracts/src/board-sequence.ts';
export const REFERENCE_ROLES_BY_SOURCE = REFERENCE_SOURCE_ROLES;

/** The frozen asset evidence one reference edge (or subject version) carries. */
export interface ReferenceSourceAsset {
  readonly assetId: string;
  readonly sha256: string;
  readonly mimeType: string;
  readonly assetName?: string;
  readonly sizeBytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
}

export interface ResolvedReferenceSource extends ReferenceSourceAsset {
  readonly nodeId: string;
  readonly kind: ReferenceSourceKind;
  /** Already-resolved card/asset name for the property panel; the service plan
   * never asks the browser to look up owners again. */
  readonly label: string;
}

function sourceKindOf(value: unknown): ReferenceSourceKind | 'subject_card' | null {
  if (value === 'subject_card') return 'subject_card';
  if (value === 'image' || value === 'video' || value === 'audio' || value === 'previs') return value;
  return null;
}

function liveNode(store: ProjectStore, nodeId: string): Row {
  const value = row(store, 'SELECT id,projectId,data FROM project.nodes WHERE id=? AND projectId=?', nodeId, store.projectId);
  if (!value || typeof value.data !== 'string') referenceInvalid('画板节点不存在或不属于当前项目', {nodeId});
  if (isCanvasArchived(store.db, 'nodes', nodeId)) referenceInvalid('画板节点已删除，请先恢复', {nodeId});
  let data: Row;
  try { data = JSON.parse(value.data) as Row; } catch { referenceInvalid('画板节点内容无效', {nodeId}); }
  if (!data || data.id !== value.id || data.projectId !== store.projectId) referenceInvalid('画板节点内容无效', {nodeId});
  return data;
}

function liveShot(store: ProjectStore, shotId: string): Row {
  const value = row(store, 'SELECT id,projectId,data FROM project.shots WHERE id=? AND projectId=?', shotId, store.projectId);
  if (!value || typeof value.data !== 'string') referenceInvalid('镜头不存在或不属于当前项目', {shotId});
  if (isCanvasArchived(store.db, 'shots', shotId)) referenceInvalid('镜头已删除，请先恢复', {shotId});
  let data: Row;
  try { data = JSON.parse(value.data) as Row; } catch { referenceInvalid('镜头内容无效', {shotId}); }
  if (!data || data.id !== value.id || data.projectId !== store.projectId) referenceInvalid('镜头内容无效', {shotId});
  return data;
}

function assetMetadata(store: ProjectStore, assetId: string, expectedPrefix: string): ReferenceSourceAsset {
  let asset: Row;
  try { asset = readGenerationAsset(store.db, assetId, store.projectId) as unknown as Row; }
  catch (error) {
    if (error instanceof AppError) throw new AppError(error.code, error.message, error.status, error.details);
    throw error;
  }
  const mimeType = typeof asset.mimeType === 'string' ? asset.mimeType : '';
  if (!mimeType.startsWith(expectedPrefix)) referenceInvalid('参考素材类型与连线用途不符', {assetId});
  if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(asset.sha256)) referenceInvalid('参考素材缺少可信指纹', {assetId});
  const duration = Number(asset.durationSeconds ?? asset.duration);
  return {assetId, sha256: asset.sha256, mimeType,
    ...(typeof asset.name === 'string' && asset.name ? {assetName: asset.name} : {}),
    ...(Number.isSafeInteger(asset.sizeBytes) && asset.sizeBytes > 0 ? {sizeBytes: Number(asset.sizeBytes)} : {}),
    ...(Number.isInteger(asset.width) && Number.isInteger(asset.height) ? {width: Number(asset.width), height: Number(asset.height)} : {}),
    ...(Number.isFinite(duration) && duration > 0 ? {durationSeconds: duration} : {})};
}

/** Latest verifiable published previs render for a node. The current output is
 * re-resolved on every new job, so a re-rendered composition only affects the
 * next generation; a node without a complete published output is not a valid
 * image reference yet. */
export function resolvePrevisOutputAsset(store: ProjectStore, nodeId: string): ReferenceSourceAsset {
  const candidates = store.db.prepare(`SELECT id,data FROM project.assets WHERE projectId=? AND json_valid(data)
    AND json_type(data,'$.previsOutput')='object' AND json_extract(data,'$.previsOutput.nodeId')=?
    ORDER BY json_extract(data,'$.previsOutput.sceneRevision') DESC, id LIMIT 32`).all(store.projectId, nodeId) as Row[];
  for (const candidate of candidates) {
    let asset: Row;
    try { asset = JSON.parse(String(candidate.data)) as Row; } catch { continue; }
    const source = readPrevisOutputSource(asset, store.projectId);
    if (!source) continue;
    if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(asset.sha256)) referenceInvalid('预演输出缺少可信指纹', {nodeId});
    return {assetId: String(asset.id), sha256: asset.sha256, mimeType: 'image/png',
      ...(Number.isSafeInteger(asset.sizeBytes) && asset.sizeBytes > 0 ? {sizeBytes: Number(asset.sizeBytes)} : {}),
      ...(Number.isInteger(asset.width) && Number.isInteger(asset.height) ? {width: Number(asset.width), height: Number(asset.height)} : {})};
  }
  return referenceInvalid('预演还没有可核验的输出图，请先生成并保存预演画面', {nodeId, reason: 'PREVIS_OUTPUT_REQUIRED'});
}

export function resolveReferenceSource(store: ProjectStore, nodeId: string): ResolvedReferenceSource {
  const node = liveNode(store, nodeId);
  const kind = sourceKindOf(node.type);
  if (kind === null) referenceInvalid('画板节点类型不能作为引用线来源', {nodeId, type: node.type});
  if (kind === 'subject_card') {
    referenceInvalid('主体卡连线走主体绑定（subject.binding）动作，不重复建引用边', {nodeId, reason: 'SUBJECT_BINDING_FAMILY'});
  }
  const nodeLabel = typeof node.label === 'string' && node.label ? node.label
    : typeof node.name === 'string' && node.name ? node.name : '';
  if (kind === 'previs') return {nodeId, kind, label: nodeLabel || nodeId, ...resolvePrevisOutputAsset(store, nodeId)};
  if (!isUuid(node.assetId)) referenceInvalid('素材节点还没有可用的托管素材', {nodeId});
  const asset = assetMetadata(store, node.assetId, `${kind}/`);
  return {nodeId, kind, label: nodeLabel || asset.assetName || nodeId, ...asset};
}

function referenceEdgeOf(store: ProjectStore, edgeId: string): {row: Row; edge: ReferenceEdge} | null {
  const value = row(store, 'SELECT id,projectId,data FROM project.edges WHERE id=? AND projectId=?', edgeId, store.projectId);
  if (!value || typeof value.data !== 'string') return null;
  if (isCanvasArchived(store.db, 'edges', edgeId)) referenceInvalid('引用线已删除，请先恢复', {edgeId});
  let data: unknown;
  try { data = JSON.parse(value.data); } catch { referenceInvalid('引用线内容无效', {edgeId}); }
  if (!data || typeof data !== 'object' || (data as Row).kind !== 'reference') return null;
  const parsed = format5EdgeSchema.safeParse(data);
  if (!parsed.success || parsed.data.kind !== 'reference') referenceInvalid('引用线内容无效', {edgeId});
  return {row: value, edge: parsed.data as ReferenceEdge};
}

/** Live material reference edges (never subject edges) pointing at one shot. */
export function readShotReferenceEdges(store: ProjectStore, shotId: string, options: {readonly excludeEdgeId?: string} = {}): readonly MaterialReferenceEdge[] {
  const values = store.db.prepare(`SELECT e.id AS id, e.data AS data FROM project.edges e WHERE e.projectId=?
    AND ${canvasActiveEdgeCondition(store.db, 'e')} AND json_valid(e.data)
    AND json_extract(e.data,'$.kind')='reference' AND json_extract(e.data,'$.target')=?
    ORDER BY e.id`).all(store.projectId, shotId) as Row[];
  const edges: MaterialReferenceEdge[] = [];
  for (const value of values) {
    if (value.id === options.excludeEdgeId) continue;
    let data: unknown;
    try { data = JSON.parse(String(value.data)); } catch { continue; }
    const parsed = format5EdgeSchema.safeParse(data);
    if (!parsed.success) referenceInvalid('引用线内容无效', {edgeId: String(value.id)});
    if (parsed.data.kind !== 'reference' || 'subjectBindingId' in parsed.data) continue;
    edges.push(parsed.data);
  }
  return edges.sort(compareReferenceEdges);
}

function compareReferenceEdges(left: ReferenceEdge, right: ReferenceEdge): number {
  const leftOrder = left.kind === 'reference' && left.orderIndex !== undefined ? left.orderIndex : Number.MAX_SAFE_INTEGER;
  const rightOrder = right.kind === 'reference' && right.orderIndex !== undefined ? right.orderIndex : Number.MAX_SAFE_INTEGER;
  return leftOrder - rightOrder || left.id.localeCompare(right.id);
}

const REFERENCE_EDGE_LIMIT = FORMAT5_INPUT_LIMITS.referenceEdgesPerShot;
const FRAME_ROLES = new Set<ChainReferenceRole>(FRAME_REFERENCE_ROLES);

function assertRoleCardinality(store: ProjectStore, shotId: string, role: ChainReferenceRole,
  options: {readonly exceptEdgeId?: string} = {}): void {
  if (!FRAME_ROLES.has(role)) return;
  const existing = readShotReferenceEdges(store, shotId,
    options.exceptEdgeId ? {excludeEdgeId: options.exceptEdgeId} : {})
    .filter(edge => edge.role === role);
  if (existing.length > 0) {
    throw new AppError('FORMAT5_REFERENCE_CARDINALITY', role === 'first_frame'
      ? '这个镜头已有首帧引用；请先改角色或断开旧的首帧连线' : '这个镜头已有尾帧引用；请先改角色或断开旧的尾帧连线', 409,
      {shotId, role, edgeIds: existing.map(edge => edge.id)});
  }
}

function nextOrderIndex(edges: readonly ReferenceEdge[]): number {
  let maximum = -1;
  for (const edge of edges) if (edge.orderIndex !== undefined) maximum = Math.max(maximum, edge.orderIndex);
  return Math.max(maximum + 1, edges.length);
}

function referenceEntity(edge: ReferenceEdge): SequenceEditBoardEntity {
  return {kind: 'edge', id: edge.id, data: edge as unknown as Row};
}
function shotEntity(shot: Row): SequenceEditBoardEntity {
  return {kind: 'shot', id: String(shot.id), data: shot};
}

const UNCHANGED_TIMELINE: SequenceEditTimelineDelta = Object.freeze({clips: [], cues: [], removedClipIds: [],
  removedCueIds: [], baseline: Object.freeze({kind: 'unchanged' as const})});
const stateDelta = (board: SequenceEditBoardDelta): SequenceEditStateDelta => ({board, timeline: UNCHANGED_TIMELINE});
const EMPTY_BOARD = (): SequenceEditBoardDelta => ({writes: [], removals: []});

interface ProjectionResult {
  readonly shot: Row | null;
  readonly changed: boolean;
}

/** Refresh the legacy first/last-frame shot projection from the live edge set,
 * with one optional pending change applied first. Returns the full shot row only
 * when the projection really changed, so role changes that do not touch the
 * frame slots write no shot row. */
function shotProjection(store: ProjectStore, shotId: string, pending: {
  readonly add?: MaterialReferenceEdge; readonly replace?: MaterialReferenceEdge; readonly removeEdgeId?: string;
}): ProjectionResult {
  const shot = liveShot(store, shotId);
  const edges = readShotReferenceEdges(store, shotId, {excludeEdgeId: pending.removeEdgeId})
    .filter(edge => pending.replace === undefined || edge.id !== pending.replace.id)
    .concat([...(pending.add ? [pending.add] : []), ...(pending.replace ? [pending.replace] : [])])
    .sort(compareReferenceEdges);
  const first = edges.find(edge => edge.role === 'first_frame');
  const last = edges.find(edge => edge.role === 'last_frame');
  const firstAsset = first?.sourceAssetId;
  const lastAsset = last?.sourceAssetId;
  const referenceAssetIds = firstAsset ? [firstAsset] : [];
  const lastFrameAssetId = lastAsset ?? null;
  const currentIds = Array.isArray(shot.referenceAssetIds) ? shot.referenceAssetIds : [];
  const currentLast = shot.lastFrameAssetId ?? null;
  if (currentIds.length === referenceAssetIds.length && currentIds.every((id: unknown, index: number) => id === referenceAssetIds[index])
    && currentLast === lastFrameAssetId) return {shot: null, changed: false};
  return {shot: {...shot, referenceAssetIds, lastFrameAssetId, updatedAt: now()}, changed: true};
}

export type ReferenceEdgeCommand =
  | {readonly kind: 'attach'; readonly edgeId: string; readonly shotId: string; readonly sourceNodeId: string; readonly role?: ChainReferenceRole}
  | {readonly kind: 'set-role'; readonly edgeId: string; readonly shotId: string; readonly role: ChainReferenceRole}
  | {readonly kind: 'detach'; readonly edgeId: string; readonly shotId: string}
  /** RI-b primary-image selection: complete order of one shot's material lines. */
  | {readonly kind: 'reorder'; readonly shotId: string; readonly edgeIds: readonly string[]};

function operationOf(command: ReferenceEdgeCommand): ReferenceEdgeOperation {
  switch (command.kind) {
    case 'attach': return {kind: 'reference-edge', edit: {kind: 'attach', edgeId: command.edgeId, shotId: command.shotId,
      sourceNodeId: command.sourceNodeId, ...(command.role ? {role: command.role} : {})}};
    case 'set-role': return {kind: 'reference-edge', edit: {kind: 'set-role', edgeId: command.edgeId,
      shotId: command.shotId, role: command.role}};
    case 'detach': return {kind: 'reference-edge', edit: {kind: 'detach', edgeId: command.edgeId, shotId: command.shotId}};
    case 'reorder': return {kind: 'reference-edge', edit: {kind: 'reorder', shotId: command.shotId, edgeIds: command.edgeIds}};
  }
}

/** Build the envelope a caller previews/commits through the unified
 * `sequence.preview/commit` entry. The caller must reuse the same edge id on a
 * retry; `attach` requires it to be present in `allocation.edges`. */
export function buildReferenceEdgeEnvelope(store: ProjectStore, command: ReferenceEdgeCommand,
  options: {readonly requestId: string; readonly actionId: string; readonly epoch: string;
    readonly historyPosition: number; readonly historyRevision: number}): SequenceEditEnvelope {
  if (!format5ReferenceInputs(store)) throw new TypeError('Reference lines require an admitted format-5 project');
  liveShot(store, command.shotId);
  const contentRevision = readProjectContentStamp(store.db).contentSequence;
  const state = readFormat5TimelineState(store.db, 'project');
  const header = state.header ? JSON.parse(state.header.raw) as Row : {};
  const sync = row(store, 'SELECT revision FROM project.sequence_sync_state');
  const targets: SequenceEditExpectedTarget[] = [{kind: 'shot', id: command.shotId,
    revision: targetRevision(store, 'shot', command.shotId)}];
  const existing = command.kind === 'set-role' || command.kind === 'detach' ? referenceEdgeOf(store, command.edgeId) : null;
  if ((command.kind === 'set-role' || command.kind === 'detach') && !existing) referenceInvalid('引用线不存在', {edgeId: command.edgeId});
  if (existing && (command.kind === 'set-role' || command.kind === 'detach')) {
    if (existing.edge.target !== command.shotId) referenceInvalid('引用线不属于这个镜头', {edgeId: command.edgeId, shotId: command.shotId});
    if ('subjectBindingId' in existing.edge) referenceInvalid('主体引用边走主体绑定动作', {edgeId: command.edgeId, reason: 'SUBJECT_BINDING_FAMILY'});
    if (!('sourceAssetId' in existing.edge)) referenceInvalid('引用线缺少素材身份', {edgeId: command.edgeId});
    targets.push({kind: 'edge', id: command.edgeId, revision: targetRevision(store, 'edge', command.edgeId)});
  }
  if (command.kind === 'reorder') for (const edgeId of command.edgeIds) {
    targets.push({kind: 'edge', id: edgeId, revision: targetRevision(store, 'edge', edgeId)});
  }
  const impactedEdgeIds = command.kind === 'reorder' ? [...command.edgeIds]
    : command.kind === 'attach' || command.kind === 'set-role' || command.kind === 'detach' ? [command.edgeId] : [];
  const impact: SequenceEditImpact = {nodeIds: [command.shotId], edgeIds: impactedEdgeIds,
    mainTrackClipIds: [], otherTrackItemIds: [], subtitleCueIds: []};
  const edges = command.kind === 'attach' ? [{id: command.edgeId, fromId: command.sourceNodeId, toId: command.shotId}] : [];
  return {
    contractVersion: SEQUENCE_EDIT_CONTRACT_VERSION, projectId: store.projectId, epoch: options.epoch,
    actionId: options.actionId, requestId: options.requestId, originSide: 'board', filmId: filmRoot(store),
    intents: [], referenceIntent: {side: 'board', operation: operationOf(command)},
    baseline: {contentRevision, timelineRevision: Number(header.revision ?? 1),
      syncRevision: Number(sync?.revision ?? 1), historyPosition: options.historyPosition,
      historyRevision: options.historyRevision, targets},
    impact,
    allocation: {clips: [], nodes: [], splitClips: [], edges},
  };
}

export interface ReferenceEdgePlan {
  readonly before: SequenceEditStateDelta;
  readonly after: SequenceEditStateDelta;
}

function assertTargets(store: ProjectStore, envelope: SequenceEditEnvelope): void {
  for (const target of envelope.baseline.targets) {
    if (target.kind !== 'shot' && target.kind !== 'edge') continue;
    if (targetRevision(store, target.kind, target.id) !== target.revision) conflict('引用线已被修改，请重新读取');
  }
}

function attachEdge(store: ProjectStore, envelope: SequenceEditEnvelope, edit: {
  readonly edgeId: string; readonly shotId: string; readonly sourceNodeId: string; readonly role?: ChainReferenceRole;
}): MaterialReferenceEdge {
  if (!isUuid(edit.edgeId) || !isUuid(edit.shotId) || !isUuid(edit.sourceNodeId)) referenceInvalid('引用线标识无效');
  if (row(store, 'SELECT 1 FROM project.edges WHERE id=? AND projectId=?', edit.edgeId, store.projectId)) referenceInvalid('引用线 ID 已被使用', {edgeId: edit.edgeId});
  const allocation = envelope.allocation.edges.filter(edge => edge.id === edit.edgeId);
  if (allocation.length !== 1 || allocation[0]!.fromId !== edit.sourceNodeId || allocation[0]!.toId !== edit.shotId) {
    referenceInvalid('新建引用线需要预分配的连线 ID', {edgeId: edit.edgeId});
  }
  liveShot(store, edit.shotId);
  const source = resolveReferenceSource(store, edit.sourceNodeId);
  const role = edit.role ?? defaultReferenceRole(source.kind);
  if (!referenceRoleAllowed(source.kind, role)) referenceInvalid('这个素材类型不能用所选引用角色', {role, kind: source.kind});
  if (role === 'last_frame' && !readShotReferenceEdges(store, edit.shotId).some(edge => edge.kind === 'reference' && edge.role === 'first_frame')) {
    referenceInvalid('尾帧需要先连一个首帧', {shotId: edit.shotId, role});
  }
  assertRoleCardinality(store, edit.shotId, role);
  const existing = readShotReferenceEdges(store, edit.shotId);
  if (existing.length >= REFERENCE_EDGE_LIMIT) {
    throw new AppError('FORMAT5_CAPACITY', '这个镜头的引用线已达上限', 409, {shotId: edit.shotId, limit: REFERENCE_EDGE_LIMIT});
  }
  const edge = {id: edit.edgeId, projectId: store.projectId, source: edit.sourceNodeId, target: edit.shotId,
    kind: 'reference' as const, role, sourceAssetId: source.assetId, orderIndex: nextOrderIndex(existing), createdAt: now()};
  const parsed = format5EdgeSchema.safeParse(edge);
  if (!parsed.success || parsed.data.kind !== 'reference' || !('sourceAssetId' in parsed.data)) referenceInvalid('引用线内容无效', {edgeId: edit.edgeId});
  return parsed.data;
}

/** Validate one reference intent against the live project and plan the board
 * delta (edge row and the legacy frame projection). */
export function planReferenceEdgeAction(store: ProjectStore, envelope: SequenceEditEnvelope): ReferenceEdgePlan {
  const intent = envelope.referenceIntent;
  if (!intent || envelope.intents.length !== 0) referenceInvalid('引用动作必须且只能携带一个 reference intent');
  const edit = intent.operation.edit;
  assertTargets(store, envelope);
  if (edit.kind === 'attach') {
    const edge = attachEdge(store, envelope, edit);
    const projected = shotProjection(store, edit.shotId, {add: edge});
    const original = projected.changed ? liveShot(store, edit.shotId) : null;
    return {
      before: stateDelta({writes: original ? [shotEntity(original)] : [], removals: [referenceEntity(edge)]}),
      after: stateDelta({writes: [referenceEntity(edge), ...(projected.shot ? [shotEntity(projected.shot)] : [])], removals: []}),
    };
  }
  if (edit.kind === 'reorder') {
    liveShot(store, edit.shotId);
    if (edit.edgeIds.length === 0 || new Set(edit.edgeIds).size !== edit.edgeIds.length) {
      referenceInvalid('引用线顺序清单无效', {shotId: edit.shotId, reason: 'ORDER_SET_MISMATCH'});
    }
    const edges = readShotReferenceEdges(store, edit.shotId);
    const byId = new Map(edges.map(edge => [edge.id, edge] as const));
    if (edit.edgeIds.length !== edges.length || edit.edgeIds.some(edgeId => !byId.has(edgeId))) {
      referenceInvalid('引用线顺序清单与当前连线不一致，请重新读取', {shotId: edit.shotId, reason: 'ORDER_SET_MISMATCH'});
    }
    const next: MaterialReferenceEdge[] = edit.edgeIds.map((edgeId, index) => {
      const current = byId.get(edgeId)!;
      const updated = {...current, orderIndex: index} as MaterialReferenceEdge;
      const parsed = format5EdgeSchema.safeParse(updated);
      if (!parsed.success || parsed.data.kind !== 'reference' || !('sourceAssetId' in parsed.data)) {
        referenceInvalid('引用线内容无效', {edgeId});
      }
      return parsed.data;
    });
    const changed = next.some(edge => byId.get(edge.id)?.orderIndex !== edge.orderIndex);
    if (!changed) return {before: stateDelta(EMPTY_BOARD()), after: stateDelta(EMPTY_BOARD())};
    return {
      before: stateDelta({writes: edit.edgeIds.map(edgeId => referenceEntity(byId.get(edgeId)!)), removals: []}),
      after: stateDelta({writes: next.map(referenceEntity), removals: []}),
    };
  }
  const existing = referenceEdgeOf(store, edit.edgeId);
  if (!existing) referenceInvalid('引用线不存在', {edgeId: edit.edgeId});
  if (existing.edge.target !== edit.shotId) referenceInvalid('引用线不属于这个镜头', {edgeId: edit.edgeId, shotId: edit.shotId});
  if ('subjectBindingId' in existing.edge) referenceInvalid('主体引用边走主体绑定动作', {edgeId: edit.edgeId, reason: 'SUBJECT_BINDING_FAMILY'});
  if (!('sourceAssetId' in existing.edge)) referenceInvalid('引用线缺少素材身份', {edgeId: edit.edgeId});
  const current: MaterialReferenceEdge = existing.edge;
  if (edit.kind === 'set-role') {
    const node = liveNode(store, current.source);
    const kind = sourceKindOf(node.type);
    if (kind === null || kind === 'subject_card') referenceInvalid('引用线来源已不可用', {edgeId: edit.edgeId});
    if (!referenceRoleAllowed(kind, edit.role)) referenceInvalid('这个素材类型不能用所选引用角色', {role: edit.role, kind});
    if (edit.role === 'last_frame' && !readShotReferenceEdges(store, edit.shotId, {excludeEdgeId: edit.edgeId})
      .some(edge => edge.kind === 'reference' && edge.role === 'first_frame')) {
      referenceInvalid('尾帧需要先连一个首帧', {shotId: edit.shotId, role: edit.role});
    }
    if (current.role === 'first_frame' && edit.role !== 'first_frame'
      && readShotReferenceEdges(store, edit.shotId, {excludeEdgeId: edit.edgeId})
        .some(edge => edge.role === 'last_frame')) {
      referenceInvalid('先把尾帧改成其他角色或断开，首帧才能退出', {shotId: edit.shotId});
    }
    if (current.role === edit.role) {
      // A role that already matches is a no-op: the transaction returns
      // SEQUENCE_EDIT_NOOP and writes nothing.
      return {before: stateDelta(EMPTY_BOARD()), after: stateDelta(EMPTY_BOARD())};
    }
    assertRoleCardinality(store, edit.shotId, edit.role, {exceptEdgeId: edit.edgeId});
    const next = {...current, role: edit.role} as MaterialReferenceEdge;
    if (!format5EdgeSchema.safeParse(next).success) referenceInvalid('引用线内容无效', {edgeId: edit.edgeId});
    const projected = shotProjection(store, edit.shotId, {replace: next});
    const original = projected.changed ? liveShot(store, edit.shotId) : null;
    return {
      before: stateDelta({writes: [referenceEntity(current), ...(original ? [shotEntity(original)] : [])], removals: []}),
      after: stateDelta({writes: [referenceEntity(next), ...(projected.shot ? [shotEntity(projected.shot)] : [])], removals: []}),
    };
  }
  if (current.role === 'first_frame'
    && readShotReferenceEdges(store, edit.shotId, {excludeEdgeId: edit.edgeId})
      .some(edge => edge.role === 'last_frame')) {
    referenceInvalid('先断开尾帧，再断开首帧', {shotId: edit.shotId});
  }
  const projected = shotProjection(store, edit.shotId, {removeEdgeId: edit.edgeId});
  const original = projected.changed ? liveShot(store, edit.shotId) : null;
  return {
    before: stateDelta({writes: [referenceEntity(current), ...(original ? [shotEntity(original)] : [])], removals: []}),
    after: stateDelta({writes: projected.shot ? [shotEntity(projected.shot)] : [], removals: [referenceEntity(current)]}),
  };
}

// ---------------------------------------------------------------------------
// Generation input candidates and the frozen plan
// ---------------------------------------------------------------------------

export interface Format5ReferenceCandidate {
  readonly source: 'edge' | 'subject' | 'previs';
  readonly edgeId?: string;
  readonly bindingId?: string;
  readonly sourceNodeId?: string;
  /** The board role the user connected with. */
  readonly role: ChainReferenceRole;
  readonly sourceKind: 'image' | 'video' | 'audio' | 'previs' | 'subject';
  readonly assetId: string;
  readonly sha256: string;
  readonly mimeType: string;
  readonly sizeBytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationSeconds?: number;
  readonly orderIndex: number;
  readonly label: string;
  readonly subjectVersionNumber?: number;
  readonly subjectId?: string;
  readonly subjectVersionId?: string;
  readonly bindingMode?: 'follow' | 'locked';
}

export interface Format5ReferenceCandidateSet {
  readonly shotId: string;
  readonly shotRevision: number;
  readonly candidates: readonly Format5ReferenceCandidate[];
}

/** A connected previs node whose scene names figure/prop subjects: the node is
 * the source of both the material line and of those subject references. */
interface PrevisSceneSource {
  readonly nodeId: string;
  /** Resolved previs card label; the row label appends the subject name. */
  readonly label: string;
  readonly record: PrevisNodeRecord;
}

/** Collection cap of previs scene subjects for one shot. One scene holds at
 * most 8 figures and 24 props, so a single connected previs node fits; a second
 * connected node only contributes what is left. This keeps the frozen job
 * snapshot (copied into the immutable version provenance) bounded even on an
 * extreme board. */
const PREVIS_SCENE_SUBJECT_INPUT_LIMIT = FORMAT5_INPUT_LIMITS.previsSceneSubjects;

/** Subjects a previs scene names, in figure-then-prop order. A subject already
 * bound directly to the shot is skipped entirely (its direct binding owns the
 * mode, version and role); repeats across elements or connected scenes keep the
 * first occurrence only. */
function previsSceneSubjectCandidates(store: ProjectStore, sources: readonly PrevisSceneSource[],
  directSubjectIds: ReadonlySet<string>): readonly Format5ReferenceCandidate[] {
  const candidates: Format5ReferenceCandidate[] = [];
  const seen = new Set(directSubjectIds);
  for (const source of sources) {
    if (candidates.length >= PREVIS_SCENE_SUBJECT_INPUT_LIMIT) break;
    for (const reference of resolvePrevisSceneSubjects(store, source.record.scene)) {
      if (candidates.length >= PREVIS_SCENE_SUBJECT_INPUT_LIMIT) break;
      if (seen.has(reference.subjectId)) continue;
      seen.add(reference.subjectId);
      const subject = store.db.prepare('SELECT name,kind FROM project.subjects WHERE id=? AND projectId=?')
        .get(reference.subjectId, store.projectId) as Row | undefined;
      if (!subject) referenceInvalid('主体不存在或不属于当前项目', {subjectId: reference.subjectId});
      const subjectName = typeof subject.name === 'string' && subject.name ? subject.name : reference.subjectId;
      const version = store.db.prepare('SELECT assetId,number FROM project.subject_versions WHERE id=? AND projectId=?')
        .get(reference.subjectVersionId, store.projectId) as Row | undefined;
      if (!version || !isUuid(version.assetId)) referenceInvalid('主体版本缺少素材', {subjectVersionId: reference.subjectVersionId});
      const asset = assetMetadata(store, String(version.assetId), 'image/');
      candidates.push({source: 'previs', sourceNodeId: source.nodeId,
        role: subject.kind === 'look' ? 'style_reference' : 'subject_reference', sourceKind: 'subject',
        subjectId: reference.subjectId, subjectVersionId: reference.subjectVersionId, bindingMode: reference.mode,
        orderIndex: 0, label: `${source.label} · ${subjectName}`,
        ...(Number.isSafeInteger(version.number) ? {subjectVersionNumber: Number(version.number)} : {}),
        assetId: asset.assetId, sha256: asset.sha256, mimeType: asset.mimeType,
        ...(asset.sizeBytes !== undefined ? {sizeBytes: asset.sizeBytes} : {}),
        ...(asset.width !== undefined ? {width: asset.width, height: asset.height} : {}),
        ...(asset.durationSeconds !== undefined ? {durationSeconds: asset.durationSeconds} : {})});
    }
  }
  return candidates;
}

/** Resolve every live board reference for one shot into addressable candidates.
 * Families are concatenated and numbered densely from 0: material reference
 * edges in persisted order, then active subject bindings by binding id, then the
 * figure/prop subjects named by any connected previs scene. */
export function readFormat5ShotReferenceCandidates(store: ProjectStore,
  shotIds: readonly string[]): readonly Format5ReferenceCandidateSet[] {
  if (!format5ReferenceInputs(store)) throw new TypeError('Reference inputs require an admitted format-5 project');
  const result: Format5ReferenceCandidateSet[] = [];
  for (const shotId of [...new Set(shotIds)]) {
    const shot = liveShot(store, shotId);
    const edgeCandidates: Format5ReferenceCandidate[] = [];
    const previsSources: PrevisSceneSource[] = [];
    for (const edge of readShotReferenceEdges(store, shotId)) {
      const nodeId = edge.source;
      const node = liveNode(store, nodeId);
      const kind = sourceKindOf(node.type);
      if (kind === null || kind === 'subject_card') continue;
      const resolved = kind === 'previs'
        ? resolvePrevisOutputAsset(store, nodeId)
        : assetMetadata(store, edge.sourceAssetId, `${kind}/`);
      const nodeLabel = typeof node.label === 'string' && node.label ? node.label
        : typeof node.name === 'string' && node.name ? node.name : '';
      const label = nodeLabel || resolved.assetName || nodeId;
      if (kind === 'previs') {
        if (!isPrevisNodeRecord(node)) referenceInvalid('预演节点记录无法验证', {nodeId});
        if (!previsSources.some(source => source.nodeId === nodeId)) previsSources.push({nodeId, label, record: node});
      }
      edgeCandidates.push({source: 'edge', edgeId: edge.id, sourceNodeId: nodeId, role: edge.role, sourceKind: kind,
        orderIndex: 0, label, assetId: resolved.assetId, sha256: resolved.sha256, mimeType: resolved.mimeType,
        ...(resolved.sizeBytes !== undefined ? {sizeBytes: resolved.sizeBytes} : {}),
        ...(resolved.width !== undefined ? {width: resolved.width, height: resolved.height} : {}),
        ...(resolved.durationSeconds !== undefined ? {durationSeconds: resolved.durationSeconds} : {})});
    }
    const bindingCandidates: Format5ReferenceCandidate[] = [];
    const directSubjectIds = new Set<string>();
    for (const binding of resolveGenerationSubjectInputs(store, [shotId])) {
      directSubjectIds.add(binding.subjectId);
      const version = (store.db.prepare('SELECT assetId,number FROM project.subject_versions WHERE id=? AND projectId=?')
        .get(binding.subjectVersionId, store.projectId) as Row | undefined);
      if (!version || !isUuid(version.assetId)) referenceInvalid('主体版本缺少素材', {bindingId: binding.bindingId});
      const subject = store.db.prepare('SELECT name FROM project.subjects WHERE id=? AND projectId=?')
        .get(binding.subjectId, store.projectId) as Row | undefined;
      const subjectName = typeof subject?.name === 'string' && subject.name ? subject.name : binding.subjectId;
      const asset = assetMetadata(store, String(version.assetId), 'image/');
      bindingCandidates.push({source: 'subject', bindingId: binding.bindingId, role: binding.role === 'style' ? 'style_reference' : 'subject_reference',
        sourceKind: 'subject', subjectId: binding.subjectId, subjectVersionId: binding.subjectVersionId,
        bindingMode: binding.mode, orderIndex: 0,
        label: subjectName, ...(Number.isSafeInteger(version.number) ? {subjectVersionNumber: Number(version.number)} : {}),
        assetId: asset.assetId, sha256: asset.sha256, mimeType: asset.mimeType,
        ...(asset.sizeBytes !== undefined ? {sizeBytes: asset.sizeBytes} : {}),
        ...(asset.width !== undefined ? {width: asset.width, height: asset.height} : {}),
        ...(asset.durationSeconds !== undefined ? {durationSeconds: asset.durationSeconds} : {})});
    }
    const candidates = [...edgeCandidates, ...bindingCandidates,
      ...previsSceneSubjectCandidates(store, previsSources, directSubjectIds)]
      .map((candidate, orderIndex) => ({...candidate, orderIndex}));
    result.push({shotId, shotRevision: Number(shot.revision ?? 0), candidates});
  }
  return result;
}

export type Format5GenerationMode = 'text' | 'frames' | 'references';
export type Format5GenerationInputStatus = 'used' | 'unsupported';

export interface Format5GenerationInputEntry extends Format5ReferenceCandidate {
  readonly status: Format5GenerationInputStatus;
  /** Stable reason code for UI/MT; present for every unsupported entry. */
  readonly reason?: string;
  /** The adapter slot the input was actually mapped to. */
  readonly appliedRole?: 'first_frame' | 'last_frame' | 'reference_image' | 'subject_reference' | 'reference_audio';
  readonly imageIndex?: number;
  readonly audioIndex?: number;
}

export interface Format5GenerationInputPlan {
  readonly version: 1;
  readonly shotId: string;
  readonly shotRevision: number;
  readonly mode: Format5GenerationMode;
  readonly entries: readonly Format5GenerationInputEntry[];
  /** Actual request images in provider order (frame or reference slots). */
  readonly images: readonly {readonly assetId: string; readonly sha256: string; readonly role: 'first_frame' | 'last_frame' | 'reference_image' | 'subject_reference'; readonly edgeId?: string; readonly bindingId?: string}[];
  /** Actual request reference audio clips in provider order. */
  readonly audios: readonly {readonly assetId: string; readonly sha256: string; readonly role: 'reference_audio'; readonly edgeId: string}[];
  readonly unsupported: number;
}

export interface PlanFormat5GenerationInputsOptions {
  /** Exact execution binding of the selected video connection/model; without it
   * the plan only resolves candidates and reports every service-specific check
   * as unknown (RI-b always supplies it for the property panel). */
  readonly binding?: VideoExecutionBinding;
  /** Legacy provider capabilities when no video connection exists (Mock). */
  readonly legacyService?: Format5LegacyGenerationService;
  /** Explicit primary reference chosen by the user (edge id or binding id). It
   * is placed first in the actual image order; remaining images keep the board
   * order. Ignored when it is not part of the candidate set. */
  readonly primaryReferenceId?: string;
}

const REFERENCE_ROLES = new Set<ChainReferenceRole>(['reference_image', 'composition', 'subject_reference', 'style_reference']);
const IMAGE_ROLES = new Set<ChainReferenceRole>(['first_frame', 'last_frame', 'reference_image', 'composition',
  'subject_reference', 'style_reference']);

function unsupportedReason(kind: 'frames' | 'references' | 'audio' | 'image', binding: VideoExecutionBinding | undefined,
  legacyService?: Format5LegacyGenerationService): string | undefined {
  if (!binding && !legacyService) return 'SERVICE_NOT_SELECTED';
  const profile = binding ? videoInputProfile(binding) : null;
  const roles = profile ? profile.inputs.roles : legacyService?.roles;
  if (kind === 'frames') return roles?.first_frame?.implemented ? undefined : 'UNSUPPORTED_FRAME_INPUT';
  if (kind === 'image') return roles?.reference_image?.implemented ? undefined : 'UNSUPPORTED_REFERENCE_IMAGES';
  if (kind === 'audio') return binding ? (isSeedance25Binding(binding) ? undefined : 'UNSUPPORTED_REFERENCE_AUDIO')
    : (roles?.reference_audio?.implemented ? undefined : 'UNSUPPORTED_REFERENCE_AUDIO');
  return 'UNSUPPORTED_REFERENCE_MODE';
}

/** Plan the actual generation inputs for one shot. The mode is derived from the
 * connected roles (strict frame inputs and multi-modal references are mutually
 * exclusive on the supported services); a role the selected model cannot accept
 * stays in the plan as `unsupported` with a stable reason and is never sent. */
export function planFormat5GenerationInputs(store: ProjectStore, shotId: string,
  options: PlanFormat5GenerationInputsOptions = {}): Format5GenerationInputPlan {
  const [set] = readFormat5ShotReferenceCandidates(store, [shotId]);
  if (!set) throw new TypeError('A shot reference set is required');
  const {binding, legacyService} = options;
  const entries: Format5GenerationInputEntry[] = [];
  const frames = set.candidates.filter(candidate => FRAME_ROLES.has(candidate.role));
  const referenceCandidates = set.candidates.filter(candidate => REFERENCE_ROLES.has(candidate.role));
  const audioCandidates = set.candidates.filter(candidate => candidate.role === 'reference_audio');
  const videoCandidates = set.candidates.filter(candidate => candidate.role === 'reference_video');
  const mode: Format5GenerationMode = frames.length ? 'frames' : referenceCandidates.length || audioCandidates.length ? 'references' : 'text';

  const unsupported = (candidate: Format5ReferenceCandidate, reason: string): void => {
    entries.push({...candidate, status: 'unsupported', reason});
  };

  if (mode === 'frames') {
    const frameIssue = unsupportedReason('frames', binding, legacyService);
    const first = frames.find(candidate => candidate.role === 'first_frame');
    const last = frames.find(candidate => candidate.role === 'last_frame');
    const legacyFramePair = legacyService ? (legacyService.combinations ?? []).some(combination =>
      combination.includes('first_frame') && combination.includes('last_frame')) : true;
    const firstImplemented = binding ? videoInputProfile(binding).inputs.roles.first_frame?.implemented !== false
      : legacyService ? legacyService.roles.first_frame?.implemented !== false : true;
    const lastImplemented = binding ? videoInputProfile(binding).inputs.roles.last_frame?.implemented !== false
      : legacyService ? legacyFramePair && legacyService.roles.last_frame?.implemented !== false : true;
    for (const candidate of set.candidates) {
      if (candidate === first) {
        if (frameIssue) unsupported(candidate, frameIssue);
        else if (!firstImplemented) unsupported(candidate, 'UNSUPPORTED_FIRST_FRAME');
        else entries.push({...candidate, status: 'used', appliedRole: 'first_frame', imageIndex: 1});
      } else if (candidate === last) {
        if (!first) unsupported(candidate, 'LAST_FRAME_WITHOUT_FIRST');
        else if (frameIssue) unsupported(candidate, 'UNSUPPORTED_LAST_FRAME');
        else if (!lastImplemented) unsupported(candidate, 'UNSUPPORTED_LAST_FRAME');
        else if (legacyService?.distinctAssetsRequired && candidate.assetId === first.assetId)
          unsupported(candidate, 'DUPLICATE_REFERENCE');
        else entries.push({...candidate, status: 'used', appliedRole: 'last_frame', imageIndex: 2});
      } else unsupported(candidate, 'EXCLUSIVE_MODE');
    }
  } else if (mode === 'references') {
    for (const candidate of set.candidates) {
      if (FRAME_ROLES.has(candidate.role)) unsupported(candidate, 'EXCLUSIVE_MODE');
      else if (candidate.role === 'reference_video') unsupported(candidate, 'UNSUPPORTED_REFERENCE_VIDEO');
    }
    if (legacyService) {
      // Legacy providers (Mock) advertise exact combination slots. Their image
      // profile may support a subject-reference slot with no generic reference
      // images; map that slot directly instead of pretending it is a first frame.
      const combinations = legacyService.combinations ?? [];
      let subjectCount = 0;
      for (const candidate of referenceCandidates) {
        if (candidate.role === 'subject_reference') {
          subjectCount++;
          if (!legacyService.roles.subject_reference?.implemented
            || !combinations.some(combination => combination.includes('subject_reference')))
            unsupported(candidate, 'UNSUPPORTED_REFERENCE_ROLE');
          else if (subjectCount > Number(legacyService.roles.subject_reference.max ?? 1))
            unsupported(candidate, 'CAPACITY_EXCEEDED');
          else entries.push({...candidate, status: 'used', appliedRole: 'subject_reference'});
        } else if (candidate.role === 'reference_audio') {
          if (!legacyService.roles.reference_audio?.implemented) unsupported(candidate, 'UNSUPPORTED_REFERENCE_AUDIO');
          else entries.push({...candidate, status: 'used', appliedRole: 'reference_audio'});
        } else unsupported(candidate, 'UNSUPPORTED_REFERENCE_IMAGES');
      }
    } else {
      const imageIssue = unsupportedReason('image', binding, legacyService);
      const maxImages = binding ? Number(videoInputProfile(binding).inputs.roles.reference_image?.max ?? 0)
        : Number.MAX_SAFE_INTEGER;
      const primaryId = options.primaryReferenceId;
      const ordered = [...referenceCandidates].sort((left, right) => {
        // Only an explicitly chosen id is a primary match; previs scene subjects
        // carry no edge/binding id and must keep their dense board order.
        const leftPrimary = primaryId !== undefined && (left.edgeId ?? left.bindingId) === primaryId ? 0 : 1;
        const rightPrimary = primaryId !== undefined && (right.edgeId ?? right.bindingId) === primaryId ? 0 : 1;
        return leftPrimary - rightPrimary || left.orderIndex - right.orderIndex
          || (left.edgeId ?? left.bindingId ?? '').localeCompare(right.edgeId ?? right.bindingId ?? '');
      });
      let imageIndex = 0;
      for (const candidate of ordered) {
        imageIndex++;
        if (imageIssue) unsupported(candidate, imageIssue);
        else if (imageIndex > maxImages) unsupported(candidate, 'CAPACITY_EXCEEDED');
        else entries.push({...candidate, status: 'used', appliedRole: 'reference_image', imageIndex});
      }
    }
    const audioIssue = unsupportedReason('audio', binding, legacyService);
    const maxAudios = binding && isSeedance25Binding(binding) ? 10
      : legacyService ? Number(legacyService.roles.reference_audio?.max ?? 0) : 0;
    const orderedAudio = [...audioCandidates].sort((left, right) => left.orderIndex - right.orderIndex
      || (left.edgeId ?? '').localeCompare(right.edgeId ?? ''));
    let audioIndex = 0;
    let audioSeconds = 0;
    for (const candidate of orderedAudio) {
      audioIndex++;
      if (audioIssue) unsupported(candidate, audioIssue);
      else if (audioIndex > maxAudios) unsupported(candidate, 'CAPACITY_EXCEEDED');
      else if (!Number.isFinite(candidate.durationSeconds) || candidate.durationSeconds! < 2 || candidate.durationSeconds! > 30) {
        unsupported(candidate, 'INVALID_REFERENCE_AUDIO');
      } else if (audioSeconds + candidate.durationSeconds! > 30) unsupported(candidate, 'REFERENCE_AUDIO_TOO_LONG');
      else {
        audioSeconds += candidate.durationSeconds!;
        entries.push({...candidate, status: 'used', appliedRole: 'reference_audio', audioIndex});
      }
    }
  } else {
    for (const candidate of set.candidates) unsupported(candidate, 'EXCLUSIVE_MODE');
  }

  const used = entries.filter(entry => entry.status === 'used').sort((left, right) =>
    (left.imageIndex ?? Number.MAX_SAFE_INTEGER) - (right.imageIndex ?? Number.MAX_SAFE_INTEGER)
    || (left.audioIndex ?? Number.MAX_SAFE_INTEGER) - (right.audioIndex ?? Number.MAX_SAFE_INTEGER));
  const images = used.filter(entry => entry.appliedRole !== 'reference_audio').map(entry =>
    ({assetId: entry.assetId, sha256: entry.sha256,
      role: entry.appliedRole as 'first_frame' | 'last_frame' | 'reference_image' | 'subject_reference',
      ...(entry.edgeId ? {edgeId: entry.edgeId} : {}), ...(entry.bindingId ? {bindingId: entry.bindingId} : {})}));
  const audios = used.filter(entry => entry.appliedRole === 'reference_audio').map(entry =>
    ({assetId: entry.assetId, sha256: entry.sha256, role: 'reference_audio' as const, edgeId: entry.edgeId!}));
  return {version: 1, shotId, shotRevision: set.shotRevision, mode, entries,
    images, audios, unsupported: entries.filter(entry => entry.status === 'unsupported').length};
}

/** Actual request fields handed to the existing `prepareConfiguredVideoInputs`
 * path, plus the bounded provenance the job snapshot freezes. */
export interface Format5GenerationSource {
  readonly referenceAssetIds: readonly string[];
  readonly lastFrameAssetId: string | null;
  readonly videoInput?: WanVideoInput;
  readonly freeze: Format5ReferenceInputFreeze;
}

export interface Format5ReferenceInputFreeze {
  readonly version: 1;
  readonly shotId: string;
  readonly shotRevision: number;
  readonly mode: Format5GenerationMode;
  readonly providerId: string;
  readonly connectionId: string;
  readonly configurationRevision: number;
  readonly modelEntryId: string;
  readonly modelId: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly entries: readonly {
    readonly source: 'edge' | 'subject' | 'previs';
    readonly edgeId?: string;
    readonly bindingId?: string;
    readonly sourceNodeId?: string;
    readonly role: ChainReferenceRole;
    readonly appliedRole?: string;
    readonly assetId: string;
    readonly sha256: string;
    readonly mimeType: string;
    readonly orderIndex: number;
    readonly status: Format5GenerationInputStatus;
    readonly reason?: string;
    readonly subjectId?: string;
    readonly subjectVersionId?: string;
    readonly bindingMode?: 'follow' | 'locked';
  }[];
  readonly actual: {
    readonly firstFrameAssetId: string | null;
    readonly lastFrameAssetId: string | null;
    readonly images: readonly {readonly assetId: string; readonly sha256: string; readonly role: string}[];
    readonly audios: readonly {readonly assetId: string; readonly sha256: string; readonly role: 'reference_audio'}[];
  };
  readonly primaryReferenceId: string | null;
}

/** Translate a plan into the legacy/transport source fields of the selected
 * video connection. Frames use the saved-shot projection contract; multi-modal
 * references (and Seedance reference audio) use the versioned explicit input. */
export function format5GenerationSource(plan: Format5GenerationInputPlan,
  binding: VideoExecutionBinding): Format5GenerationSource {
  const profile = videoInputProfile(binding);
  const first = plan.images.find(image => image.role === 'first_frame');
  const last = plan.images.find(image => image.role === 'last_frame');
  let source: Format5GenerationSource;
  if (plan.mode === 'frames') {
    // The saved-shot projection keeps the head in `referenceAssetIds` and the
    // tail in `lastFrameAssetId`; the adapter selection appends the tail itself.
    source = {referenceAssetIds: first ? [first.assetId] : [],
      lastFrameAssetId: last ? last.assetId : null, freeze: freezeOf(plan, binding, profile.profileId, profile.profileVersion)};
  } else if (plan.mode === 'references' && plan.images.length > 0) {
    const videoInput: WanVideoInput = {version: 1, mode: 'reference_images',
      images: plan.images.map(image => ({role: 'reference_image' as const, assetId: image.assetId})),
      ...(plan.audios.length ? {audios: plan.audios.map(audio => ({role: 'reference_audio' as const, assetId: audio.assetId}))} : {})};
    source = {referenceAssetIds: plan.images.map(image => image.assetId), lastFrameAssetId: null,
      videoInput, freeze: freezeOf(plan, binding, profile.profileId, profile.profileVersion)};
  } else if (plan.mode === 'references' && plan.audios.length > 0) {
    const videoInput: WanVideoInput = {version: 1, mode: 'reference_images', images: [],
      audios: plan.audios.map(audio => ({role: 'reference_audio' as const, assetId: audio.assetId}))};
    source = {referenceAssetIds: [], lastFrameAssetId: null, videoInput,
      freeze: freezeOf(plan, binding, profile.profileId, profile.profileVersion)};
  } else {
    source = {referenceAssetIds: [], lastFrameAssetId: null, freeze: freezeOf(plan, binding, profile.profileId, profile.profileVersion)};
  }
  if (plan.mode === 'frames' && last && !profile.inputs.roles.last_frame?.implemented) {
    // The exact model cannot accept a tail frame; never send it silently.
    source = {referenceAssetIds: first ? [first.assetId] : [], lastFrameAssetId: null,
      freeze: freezeOf(plan, binding, profile.profileId, profile.profileVersion)};
  }
  return source;
}

/** Source fields for a legacy provider whose adapter reads the saved-shot
 * projection instead of an explicit video binding (Mock). The freeze keeps the
 * same plan the projection showed so WT-3-04 cannot drift from generation. */
export function format5LegacyGenerationSource(plan: Format5GenerationInputPlan,
  service: Format5LegacyGenerationService): Format5GenerationSource {
  const first = plan.images.find(image => image.role === 'first_frame');
  const last = plan.images.find(image => image.role === 'last_frame');
  const subject = plan.images.find(image => image.role === 'subject_reference');
  return {
    referenceAssetIds: plan.mode === 'frames' ? (first ? [first.assetId] : [])
      : subject ? [subject.assetId] : plan.images.map(image => image.assetId),
    lastFrameAssetId: plan.mode === 'frames' ? (last?.assetId ?? null) : null,
    freeze: freezeOfLegacy(plan, service),
  };
}

function freezeOfLegacy(plan: Format5GenerationInputPlan,
  service: Format5LegacyGenerationService): Format5ReferenceInputFreeze {
  const first = plan.images.find(image => image.role === 'first_frame');
  const last = plan.images.find(image => image.role === 'last_frame');
  return {
    version: 1, shotId: plan.shotId, shotRevision: plan.shotRevision, mode: plan.mode,
    providerId: service.providerId, connectionId: FORMAT5_MOCK_INPUT_CONNECTION_ID,
    configurationRevision: FORMAT5_MOCK_INPUT_CONFIGURATION_REVISION,
    modelEntryId: FORMAT5_MOCK_INPUT_MODEL_ENTRY_ID, modelId: service.modelId,
    profileId: service.profileId, profileVersion: service.profileVersion,
    entries: plan.entries.map(entry => ({source: entry.source, ...(entry.edgeId ? {edgeId: entry.edgeId} : {}),
      ...(entry.bindingId ? {bindingId: entry.bindingId} : {}), ...(entry.sourceNodeId ? {sourceNodeId: entry.sourceNodeId} : {}),
      role: entry.role, ...(entry.appliedRole ? {appliedRole: entry.appliedRole} : {}), assetId: entry.assetId,
      sha256: entry.sha256, mimeType: entry.mimeType, orderIndex: entry.orderIndex, status: entry.status,
      ...(entry.reason ? {reason: entry.reason} : {}), ...(entry.subjectId ? {subjectId: entry.subjectId} : {}),
      ...(entry.subjectVersionId ? {subjectVersionId: entry.subjectVersionId} : {}),
      ...(entry.bindingMode ? {bindingMode: entry.bindingMode} : {})})),
    actual: {firstFrameAssetId: first?.assetId ?? null, lastFrameAssetId: last?.assetId ?? null,
      images: plan.images.map(image => ({assetId: image.assetId, sha256: image.sha256, role: image.role})),
      audios: plan.audios.map(audio => ({assetId: audio.assetId, sha256: audio.sha256, role: audio.role}))},
    primaryReferenceId: null,
  };
}

function freezeOf(plan: Format5GenerationInputPlan, binding: VideoExecutionBinding,
  profileId: string, profileVersion: string): Format5ReferenceInputFreeze {
  const first = plan.images.find(image => image.role === 'first_frame');
  const last = plan.images.find(image => image.role === 'last_frame');
  return {
    version: 1, shotId: plan.shotId, shotRevision: plan.shotRevision, mode: plan.mode,
    providerId: binding.providerId, connectionId: binding.connectionId,
    configurationRevision: binding.configurationRevision, modelEntryId: binding.model.id, modelId: binding.model.modelId,
    profileId, profileVersion,
    entries: plan.entries.map(entry => ({source: entry.source, ...(entry.edgeId ? {edgeId: entry.edgeId} : {}),
      ...(entry.bindingId ? {bindingId: entry.bindingId} : {}), ...(entry.sourceNodeId ? {sourceNodeId: entry.sourceNodeId} : {}),
      role: entry.role, ...(entry.appliedRole ? {appliedRole: entry.appliedRole} : {}), assetId: entry.assetId,
      sha256: entry.sha256, mimeType: entry.mimeType, orderIndex: entry.orderIndex, status: entry.status,
      ...(entry.reason ? {reason: entry.reason} : {}), ...(entry.subjectId ? {subjectId: entry.subjectId} : {}),
      ...(entry.subjectVersionId ? {subjectVersionId: entry.subjectVersionId} : {}),
      ...(entry.bindingMode ? {bindingMode: entry.bindingMode} : {})})),
    actual: {firstFrameAssetId: first?.assetId ?? null, lastFrameAssetId: last?.assetId ?? null,
      images: plan.images.map(image => ({assetId: image.assetId, sha256: image.sha256, role: image.role})),
      audios: plan.audios.map(audio => ({assetId: audio.assetId, sha256: audio.sha256, role: audio.role}))},
    primaryReferenceId: plan.images.find(image => image.role === 'reference_image')?.edgeId
      ?? plan.images.find(image => image.role === 'reference_image')?.bindingId ?? null,
  };
}

/** Frozen plan a job snapshot stores. Kept bounded (≤48 reference lines, ≤8
 * subject bindings and ≤32 previs scene subjects) because it is copied into the
 * immutable generation version provenance. */
export function readFrozenFormat5GenerationInputs(snapshot: unknown): Format5ReferenceInputFreeze | null {
  if (snapshot === null || typeof snapshot !== 'object') return null;
  const value = (snapshot as Row).format5ReferenceInputs;
  return value && typeof value === 'object' && (value as Row).version === 1
    ? value as Format5ReferenceInputFreeze : null;
}

/** True when the snapshot belongs to the format-5 board-input path. */
export function hasFrozenFormat5GenerationInputs(snapshot: unknown): boolean {
  return readFrozenFormat5GenerationInputs(snapshot) !== null;
}

// ---------------------------------------------------------------------------
// Property-panel projection (RI-b)
// ---------------------------------------------------------------------------

/** Legacy provider capabilities (Mock) that have no configured video connection.
 * The roles are the reviewed input-profile roles; the read-only projection uses
 * them exactly as it uses a video binding's profile. */
export interface Format5LegacyGenerationService {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelName: string;
  readonly profileId: string;
  readonly profileVersion: string;
  readonly roles: Readonly<Record<string, {readonly implemented?: boolean; readonly max?: number}>>;
  readonly maxReferences?: number;
  readonly combinations?: readonly (readonly string[])[];
  readonly distinctAssetsRequired?: boolean;
}
export interface ReadFormat5GenerationInputOptions {
  /** Exact selected video connection/model; omitted while no service is chosen,
   * which reports every input as unsupported with SERVICE_NOT_SELECTED. */
  readonly binding?: VideoExecutionBinding;
  /** Legacy provider capabilities when no video connection exists (Mock). */
  readonly legacyService?: Format5LegacyGenerationService;
  /** Explicit primary image chosen in the panel (edge or binding id). */
  readonly primaryReferenceId?: string;
  /** Current "生成声音" switch; omitted reports the service default. */
  readonly generateAudio?: boolean;
}

/** Live generation-input projection shared by the board property panel and the
 * read-only RPC. Labels are resolved here so the browser never invents owners or
 * subject versions; hashes stay in the frozen job snapshot, not in this view. */
export function readFormat5GenerationInputView(store: ProjectStore, shotId: string,
  options: ReadFormat5GenerationInputOptions = {}): SequenceGenerationInputView {
  const plan = planFormat5GenerationInputs(store, shotId, {
    ...(options.binding ? {binding: options.binding} : {}),
    ...(options.legacyService ? {legacyService: options.legacyService} : {}),
    ...(options.primaryReferenceId ? {primaryReferenceId: options.primaryReferenceId} : {}),
  });
  const profile = options.binding ? videoInputProfile(options.binding) : null;
  const primaryEdgeId = plan.images.find(image => image.role === 'reference_image')?.edgeId ?? null;
  const entries: SequenceGenerationInputEntryView[] = plan.entries.map(entry => ({
    source: entry.source,
    ...(entry.edgeId ? {edgeId: entry.edgeId} : {}),
    ...(entry.bindingId ? {bindingId: entry.bindingId} : {}),
    ...(entry.sourceNodeId ? {sourceNodeId: entry.sourceNodeId} : {}),
    sourceKind: entry.sourceKind,
    role: entry.role,
    ...(entry.appliedRole ? {appliedRole: entry.appliedRole} : {}),
    status: entry.status,
    ...(entry.reason ? {reason: entry.reason} : {}),
    label: entry.label,
    ...(entry.subjectVersionNumber !== undefined ? {subjectVersionNumber: entry.subjectVersionNumber} : {}),
    orderIndex: entry.orderIndex,
    ...(primaryEdgeId !== null && entry.edgeId === primaryEdgeId ? {primary: true} : {}),
  }));
  const shotRow = store.db.prepare('SELECT data FROM project.shots WHERE id=? AND projectId=?')
    .get(shotId, store.projectId) as {data?: unknown} | undefined;
  let basePrompt = '';
  try {
    const data = typeof shotRow?.data === 'string' ? JSON.parse(shotRow.data) as Row : {};
    basePrompt = typeof data.prompt === 'string' ? data.prompt : '';
  } catch { basePrompt = ''; }
  const dialogue = format5DialogueView(planFormat5DialogueGeneration(store, shotId,
    {...(options.binding ? {binding: options.binding} : {}),
     ...(options.legacyService ? {legacyService: {providerId: options.legacyService.providerId}} : {}), basePrompt,
     ...(options.generateAudio !== undefined ? {generateAudio: options.generateAudio} : {})}));
  return {
    projectId: store.projectId,
    shotId,
    shotRevision: plan.shotRevision,
    mode: plan.mode,
    service: options.binding && profile ? {providerId: options.binding.providerId,
      modelId: options.binding.model.modelId, modelName: options.binding.model.name ?? options.binding.model.modelId,
      profileId: profile.profileId, profileVersion: profile.profileVersion}
      : options.legacyService ? {providerId: options.legacyService.providerId,
        modelId: options.legacyService.modelId, modelName: options.legacyService.modelName,
        profileId: options.legacyService.profileId, profileVersion: options.legacyService.profileVersion} : null,
    entries,
    usedCount: plan.entries.filter(entry => entry.status === 'used').length,
    unsupportedCount: plan.unsupported,
    primaryEdgeId,
    dialogue,
  };
}
