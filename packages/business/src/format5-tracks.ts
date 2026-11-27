/** FR-D: format-5 track management as one shared `sequence-edit` action.
 *
 * Only additive operations exist: a track may be added or renamed/hidden/
 * muted/reordered. A track's id and kind never change and the main-track
 * association (`mainTrack.trackId`/`sequenceNodeId`) is never touched. Deleting
 * a track is not part of the format-5 contract: formats 3/4 expose no delete
 * entry either, and removing a main track would break the only authoritative
 * chain. Track locking remains a client view protection; it is not persisted
 * timeline data and therefore not an intent.
 *
 * The full header track rows travel in the timeline half of the history patch,
 * so undo/redo restore names, visibility, mute and order in the same history-13
 * step as every other edit.
 */
import {randomUUID} from 'node:crypto';
import {AppError} from '../../contracts/src/app-error.ts';
import {sequenceEditPreviewFailure} from './format5-sequence-preview-errors.ts';
import {FORMAT5_LIMITS, getFormat5TrackIssue} from '../../contracts/src/project-format5.ts';
import type {Format5Timeline} from '../../contracts/src/project-format5.ts';
import type {
  SequenceEditAffectedCounts, SequenceEditEnvelope, SequenceEditImpact, SequenceEditStateDelta,
  SequenceEditTimelineDelta, SequenceEditTrackEdit, SequenceEditTrackIntent,
} from '../../contracts/src/sequence-edit.ts';
import {SEQUENCE_EDIT_CONTRACT_VERSION, sequenceEditEnvelopeOperationName} from '../../contracts/src/sequence-edit.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import {readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
import type {ProjectStore} from './project-file/store.ts';
import {findSequenceEditReceipt, prepareSequenceEditHistory, sequenceEditInputDigest, writeSequenceEditAction,
  writeSequenceEditFailure} from './format5-editor-history.ts';
import type {SequenceEditReceiptDraft} from './format5-editor-history.ts';
import {applySequenceEditTimelineDelta} from './format5-sequence-sync.ts';

type Row = Record<string, unknown>;
type Track = Format5Timeline['tracks'][number];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
function invalid(message: string, details: Row = {}): never {
  throw new AppError('SEQUENCE_EDIT_TRACK_INVALID', message, 409, details);
}
const failure = (code: string, ids: readonly string[] = []): {ok: false; code: string; ids: readonly string[]} =>
  ({ok: false, code, ids});
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export interface TrackPlan {
  readonly before: SequenceEditStateDelta;
  readonly after: SequenceEditStateDelta;
  readonly changedTrackIds: readonly string[];
}
const timelineDelta = (tracks: readonly Track[]): SequenceEditTimelineDelta => ({
  clips: [], cues: [], removedClipIds: [], removedCueIds: [], tracks, baseline: {kind: 'unchanged' as const},
});
const stateDelta = (tracks: readonly Track[]): SequenceEditStateDelta =>
  ({board: {writes: [], removals: []}, timeline: timelineDelta(tracks)});

function trackName(edit: Extract<SequenceEditTrackEdit, {kind: 'add'}>, tracks: readonly Track[]): string {
  const fallback = `${edit.trackKind === 'video' ? 'Video' : 'Audio'} ${tracks.filter(track => track.kind === edit.trackKind).length + 1}`;
  const name = edit.name?.trim() ?? fallback;
  if (!name.length || Buffer.byteLength(name) > 600) invalid('轨道名称不能为空且最多 150 个字符');
  return name;
}
function assertUniqueOrder(tracks: readonly Track[], trackId: string, orderIndex: number): void {
  if (tracks.some(track => track.id !== trackId && track.orderIndex === orderIndex)) invalid('轨道顺序位置已被占用');
}
function validateTrack(track: unknown): void {
  const issue = getFormat5TrackIssue(track);
  if (issue) invalid(issue.message ?? '轨道内容无效');
}

function assertMainTrackIdentity(before: Format5Timeline, tracks: readonly Track[]): void {
  const main = tracks.find(track => track.id === before.mainTrack.trackId);
  if (!main || main.kind !== 'video') invalid('主轨身份不能改变');
}

export function planTrack(store: ProjectStore, intent: SequenceEditTrackIntent): TrackPlan {
  const record = readFormat5TimelineRecord(store.db, 'project');
  if (!record) invalid('项目没有格式 5 时间线');
  const before = clone(record.tracks) as Track[];
  const after = clone(record.tracks) as Track[];
  const edit = intent.operation.edit;
  if (!isUuid(edit.trackId)) invalid('轨道 ID 无效');
  let changed: Track;
  if (edit.kind === 'add') {
    if (after.some(track => track.id === edit.trackId)) invalid('轨道 ID 已被使用');
    if (after.length >= FORMAT5_LIMITS.tracks) invalid(`轨道数量最多 ${FORMAT5_LIMITS.tracks} 条`);
    if (edit.trackKind !== 'video' && edit.trackKind !== 'audio') invalid('轨道类型无效');
    const orderIndex = edit.orderIndex ?? Math.max(-1, ...after.map(track => track.orderIndex)) + 1;
    if (!Number.isSafeInteger(orderIndex) || orderIndex < 0 || orderIndex >= FORMAT5_LIMITS.tracks) invalid('轨道顺序无效');
    assertUniqueOrder(after, edit.trackId, orderIndex);
    changed = {id: edit.trackId, name: trackName(edit, after), kind: edit.trackKind, orderIndex, hidden: false, muted: false};
    after.push(changed);
  } else {
    const current = after.find(track => track.id === edit.trackId);
    if (!current) invalid('轨道不存在');
    const keys = Object.keys(edit.patch);
    if (keys.length === 0) invalid('轨道补丁不能为空');
    const next = {...current};
    if (edit.patch.name !== undefined) {
      const name = edit.patch.name.trim();
      if (!name.length || Buffer.byteLength(name) > 600) invalid('轨道名称不能为空且最多 150 个字符');
      next.name = name;
    }
    if (edit.patch.hidden !== undefined) {
      if (typeof edit.patch.hidden !== 'boolean') invalid('轨道隐藏值无效');
      if (next.kind === 'audio' && edit.patch.hidden) invalid('音频轨不支持隐藏画面');
      next.hidden = edit.patch.hidden;
    }
    if (edit.patch.muted !== undefined) {
      if (typeof edit.patch.muted !== 'boolean') invalid('轨道静音值无效');
      next.muted = edit.patch.muted;
    }
    if (edit.patch.orderIndex !== undefined) {
      const orderIndex = edit.patch.orderIndex;
      if (!Number.isSafeInteger(orderIndex) || orderIndex < 0 || orderIndex >= FORMAT5_LIMITS.tracks) invalid('轨道顺序无效');
      assertUniqueOrder(after, edit.trackId, orderIndex);
      next.orderIndex = orderIndex;
    }
    changed = next;
    after[after.findIndex(track => track.id === edit.trackId)] = changed;
  }
  for (const track of after) validateTrack(track);
  assertMainTrackIdentity(record, after);
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return {before: stateDelta(before), after: stateDelta(after), changedTrackIds: []};
  }
  return {before: stateDelta(before), after: stateDelta(after), changedTrackIds: [changed.id]};
}

export function buildTrackEnvelope(store: ProjectStore, edit: SequenceEditTrackEdit,
  options: {readonly requestId: string; readonly actionId: string; readonly epoch: string;
    readonly historyPosition: number; readonly historyRevision: number; readonly origin?: 'user' | 'mio';}): SequenceEditEnvelope {
  const record = readFormat5TimelineRecord(store.db, 'project');
  if (!record) invalid('项目没有格式 5 时间线');
  if (!isUuid(edit.trackId)) invalid('轨道 ID 无效');
  const impact: SequenceEditImpact = {nodeIds: [], edgeIds: [], mainTrackClipIds: [], otherTrackItemIds: [],
    subtitleCueIds: [], trackIds: [edit.trackId]};
  const content = readProjectContentStamp(store.db).contentSequence;
  const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
  return {
    contractVersion: SEQUENCE_EDIT_CONTRACT_VERSION, projectId: store.projectId, epoch: options.epoch,
    actionId: options.actionId, requestId: options.requestId, originSide: 'timeline',
    ...(options.origin ? {origin: options.origin} : {}), filmId: record.mainTrack.sequenceNodeId,
    intents: [], trackIntent: {side: 'timeline', operation: {kind: 'track-structure', edit}},
    baseline: {contentRevision: content, timelineRevision: record.revision,
      syncRevision: Number(sync?.revision ?? 1), historyPosition: options.historyPosition,
      historyRevision: options.historyRevision, targets: []},
    impact, allocation: {clips: [], nodes: [], splitClips: [], edges: []},
  };
}

export interface TrackPreview {readonly envelope: SequenceEditEnvelope; readonly planDigest: string; readonly warnings: readonly {code: string}[];}
export function previewTrack(store: ProjectStore, input: {readonly requestId: string; readonly actionId?: string;
  readonly origin?: 'user' | 'mio'; readonly trackIntent: SequenceEditTrackIntent}): TrackPreview | {ok: false; code: string; ids: readonly string[]} {
  try {
    const state = prepareSequenceEditHistory(store).state;
    const envelope = buildTrackEnvelope(store, input.trackIntent.operation.edit, {requestId: input.requestId,
      actionId: input.actionId ?? randomUUID(), epoch: state.epoch, historyPosition: state.position,
      historyRevision: state.revision, ...(input.origin ? {origin: input.origin} : {})});
    const plan = planTrack(store, input.trackIntent);
    if (!plan.changedTrackIds.length) return failure('SEQUENCE_EDIT_NOOP', [input.trackIntent.operation.edit.trackId]);
    return {envelope, planDigest: sequenceEditInputDigest(envelope), warnings: []};
  } catch (error) {
    if (error instanceof AppError) return sequenceEditPreviewFailure(error);
    throw error;
  }
}

/** One transaction: replay, CAS, track validation, timeline delta, one history entry. */
export function runTrackSync(store: ProjectStore, envelope: SequenceEditEnvelope): {
  readonly ok: true; readonly actionId: string; readonly operation: string; readonly patch: unknown; readonly receipt: unknown;
} | {readonly ok: false; readonly code: string; readonly ids: readonly string[]} {
  const intent = envelope.trackIntent;
  if (!intent || envelope.intents.length !== 0) return failure('SEQUENCE_EDIT_CONTRACT_INVALID');
  return store.tx(() => {
    const replay = findSequenceEditReceipt(store, envelope.requestId);
    const inputDigest = sequenceEditInputDigest(envelope);
    if (replay) {
      if (replay.inputDigest !== inputDigest) return failure('SEQUENCE_EDIT_REQUEST_REUSED');
      if (replay.receipt.status === 'not_applied') return failure(replay.receipt.code ?? 'SEQUENCE_EDIT_NOOP', replay.receipt.failure?.ids);
      return {ok: true, actionId: replay.receipt.actionId, operation: replay.receipt.operation, patch: null,
        receipt: replay.receipt};
    }
    const record = readFormat5TimelineRecord(store.db, 'project');
    if (!record) return failure('SEQUENCE_EDIT_TRACK_INVALID');
    const content = readProjectContentStamp(store.db).contentSequence;
    const sync = store.db.prepare('SELECT revision FROM project.sequence_sync_state').get() as Row | undefined;
    if (envelope.baseline.contentRevision !== content || envelope.baseline.timelineRevision !== record.revision
      || envelope.baseline.syncRevision !== Number(sync?.revision ?? 1)) {
      writeSequenceEditFailure(store, envelope, 'SEQUENCE_EDIT_REVISION_CONFLICT');
      return failure('SEQUENCE_EDIT_REVISION_CONFLICT');
    }
    let plan: TrackPlan;
    try { plan = planTrack(store, intent); }
    catch (error) {
      if (error instanceof AppError && error.code === 'SEQUENCE_EDIT_TRACK_INVALID') {
        writeSequenceEditFailure(store, envelope, error.code);
        return failure(error.code);
      }
      throw error;
    }
    if (!plan.changedTrackIds.length) {
      const ids = [intent.operation.edit.trackId];
      writeSequenceEditFailure(store, envelope, 'SEQUENCE_EDIT_NOOP', {ids});
      return failure('SEQUENCE_EDIT_NOOP', ids);
    }
    const applied = applySequenceEditTimelineDelta(store, plan.after.timeline);
    const affected: SequenceEditAffectedCounts = {nodes: 0, edges: 0, mainTrackClips: 0, otherTrackItems: 0,
      subtitleCues: 0, tracks: plan.changedTrackIds.length};
    const contentRevision = readProjectContentStamp(store.db).contentSequence;
    const receipt: SequenceEditReceiptDraft = {version: SEQUENCE_EDIT_CONTRACT_VERSION,
      requestId: envelope.requestId, inputDigest, projectId: store.projectId, actionId: envelope.actionId,
      operation: sequenceEditEnvelopeOperationName(envelope), originSide: envelope.originSide,
      status: 'applied', affected, contentRevision, timelineRevision: applied.timelineRevision,
      syncRevision: Number(sync?.revision ?? 1)};
    const patch = {version: SEQUENCE_EDIT_CONTRACT_VERSION, before: plan.before, after: plan.after};
    const stored = writeSequenceEditAction(store, {envelope, patch, receipt});
    return {ok: true, actionId: envelope.actionId, operation: stored.operation, patch, receipt: stored};
  });
}
