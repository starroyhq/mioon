/** Bounded Mio/MT write actions for format-5 sequences.
 *
 * One model action is expanded and previewed server-side into the shared
 * envelope; the tool runtime obtains approval for the stable impact, then
 * commits exactly that envelope + plan digest. The model never supplies an
 * envelope, allocation, receipt or raw generated id.
 */
import {randomUUID} from 'node:crypto';
import {AppError} from '../../contracts/src/app-error.ts';
import {createFormat5SequenceEditService} from './format5-sequence-edit-service.ts';
import {createSequenceEditing, readSequenceEditHistory} from './sequence-edit.ts';
import {readSequenceEditHistoryEntry} from './format5-editor-history.ts';
import {readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
import {sequenceSyncIntent} from '../../contracts/src/sequence-sync.ts';
import type {MioSequenceAction} from '../../contracts/src/mio-sequence.ts';
import type {SequenceEditDialogueEdit, SequenceEditDialogueIntent} from '../../contracts/src/sequence-edit.ts';
import type {SequenceEditEnvelope, SequenceEditIntent, SequenceEditReceipt, SequenceEditSubjectIntent} from '../../contracts/src/sequence-edit.ts';
import type {ProjectStore} from './project-file/store.ts';

type Row = Record<string, any>;
const f5 = (store: ProjectStore): boolean => {
  try {
    return Number((store.db.prepare("SELECT length(name) AS n FROM project.sqlite_schema WHERE type='table' AND name='timeline_clips' LIMIT 1").get() as Row | undefined)?.n) > 0;
  } catch { return false; }
};
const requireF5 = (store: ProjectStore): void => {
  if (!f5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于格式 5 项目。', 409, {reason: 'FORMAT_REQUIRED'});
};
const projectCheck = (store: ProjectStore, projectId: unknown): void => {
  if (projectId !== store.projectId) throw new AppError('PROJECT_ID_MISMATCH', '项目地址与请求不一致。', 409);
};
const clipRow = (store: ProjectStore, clipId: string): Row => {
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  const clip = timeline?.clips.find(value => value.id === clipId);
  if (!clip) throw new AppError('SEQUENCE_EDIT_TARGET_NOT_FOUND', '剪辑片段不属于当前格式 5 主轨。', 404, {clipId});
  return clip as unknown as Row;
};
const versionOf = (store: ProjectStore, nodeId: string): string | null => {
  const shot = store.db.prepare('SELECT data FROM project.shots WHERE id=?').get(nodeId) as Row | undefined;
  if (!shot || typeof shot.data !== 'string') return null;
  try { const value = JSON.parse(shot.data); return typeof value.selectedVersionId === 'string' ? value.selectedVersionId : null; }
  catch { return null; }
};
function trackCommand(store: ProjectStore, action: MioSequenceAction, timeline: {mainTrack?: {trackId?: string}}): ReturnType<typeof sequenceSyncIntent> {
  switch (action.kind) {
    case 'reorder': return sequenceSyncIntent({kind: 'clip-move', clipId: action.clipId, beforeClipId: action.beforeClipId});
    case 'remove': return sequenceSyncIntent({kind: 'clip-remove', clipId: action.clipId});
    case 'split': return sequenceSyncIntent({kind: 'clip-split', clipId: action.clipId,
      offsetFrames: action.offsetFrames, rightClipId: randomUUID()});
    case 'copy-move': return sequenceSyncIntent({kind: 'clip-move', clipId: action.clipId,
      beforeClipId: action.beforeClipId, copyNodeId: randomUUID()});
    case 'set-mode': {
      const clip = clipRow(store, action.clipId);
      const nodeId = String((clip as Row).sequenceSource?.nodeId ?? '');
      const versionId = action.versionId === undefined
        ? (action.mode === 'follow' ? versionOf(store, nodeId) : (typeof clip.versionId === 'string' ? clip.versionId : null))
        : action.versionId;
      return sequenceSyncIntent({kind: 'clip-version', clipId: action.clipId, versionId, mode: action.mode});
    }
    default: throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '不是时间线动作。', 409);
  }
}
function boardIntent(action: MioSequenceAction): SequenceEditIntent {
  switch (action.kind) {
    case 'connect': return {side: 'board', operation: {kind: 'board', edit: {kind: 'connect', fromId: action.fromId, toId: action.toId}}};
    case 'disconnect': return {side: 'board', operation: {kind: 'board', edit: {kind: 'disconnect', fromId: action.fromId, toId: action.toId}}};
    case 'insert': return {side: 'board', operation: {kind: 'board', edit: {kind: 'insert', fromId: action.fromId, toId: action.toId, nodeId: action.nodeId}}};
    case 'delete-node': return {side: 'board', operation: {kind: 'board', edit: {kind: 'delete', nodeId: action.nodeId}}};
    default: throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '不是画板动作。', 409);
  }
}
/** DL-a: one shot's dialogue lines as the shared contract intent. The model
 * names text/lines from `sequence.inspect`; line ids for new lines are generated
 * here so a model never supplies row identities. */
function dialogueIntent(action: Extract<MioSequenceAction, {kind: 'dialogue'}>): SequenceEditDialogueIntent {
  const edits: SequenceEditDialogueEdit[] = action.edits.map(edit => {
    switch (edit.kind) {
      case 'add': return {kind: 'add' as const, shotId: action.shotId,
        line: {id: randomUUID(), text: edit.text,
          ...(edit.speakerSubjectId !== undefined && edit.speakerSubjectId !== null ? {speakerSubjectId: edit.speakerSubjectId} : {})},
        ...(edit.beforeLineId === undefined ? {} : {beforeLineId: edit.beforeLineId})};
      case 'update': return {kind: 'update' as const, shotId: action.shotId, lineId: edit.lineId,
        ...(edit.text === undefined ? {} : {text: edit.text}),
        ...(edit.speakerSubjectId === undefined ? {} : {speakerSubjectId: edit.speakerSubjectId})};
      case 'remove': return {kind: 'remove' as const, shotId: action.shotId, lineId: edit.lineId};
      case 'reorder': return {kind: 'reorder' as const, shotId: action.shotId, lineIds: edit.lineIds};
    }
  });
  return {side: 'board', operation: {kind: 'dialogue', edits}};
}
function subjectIntent(action: Extract<MioSequenceAction, {kind: 'subject-binding'}>): SequenceEditSubjectIntent {
  const edit = action.edit.kind === 'create' ? {...action.edit, bindingId: randomUUID()} : action.edit;
  return {side: 'board', operation: {kind: 'subject-binding', edit} as SequenceEditSubjectIntent['operation']};
}
export interface MioSequencePlan {
  readonly envelope: SequenceEditEnvelope;
  readonly planDigest: string;
  readonly summary: {
    readonly action: string; readonly affected: readonly string[];
    readonly counts: {readonly nodes: number; readonly edges: number; readonly clips: number; readonly other: number};
    readonly warnings: number;
  };
}
function summarize(action: MioSequenceAction, envelope: SequenceEditEnvelope, warnings: readonly unknown[]): MioSequencePlan['summary'] {
  const impact = envelope.impact as unknown as Row;
  const affected = [...new Set([...(impact.nodeIds ?? []), ...(impact.edgeIds ?? []), ...(impact.mainTrackClipIds ?? []),
    ...(impact.otherTrackItemIds ?? []), ...(impact.subtitleCueIds ?? [])].map(String))].slice(0, 50);
  return {action: action.kind, affected,
    counts: {nodes: (impact.nodeIds ?? []).length, edges: (impact.edgeIds ?? []).length,
      clips: (impact.mainTrackClipIds ?? []).length, other: (impact.otherTrackItemIds ?? []).length + (impact.subtitleCueIds ?? []).length},
    warnings: warnings.length};
}
/** Preview one bounded action and return the exact envelope to commit. */
export function previewMioSequenceAction(store: ProjectStore, projectId: string, requestId: string, action: MioSequenceAction): MioSequencePlan {
  requireF5(store);
  projectCheck(store, projectId);
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  if (!timeline) throw new AppError('SEQUENCE_EDIT_TARGET_NOT_FOUND', '项目没有格式 5 主轨。', 404);
  const request: Row = {projectId, requestId, origin: 'mio'};
  if (action.kind === 'subject-binding') request.subjectIntent = subjectIntent(action);
  else if (action.kind === 'dialogue') request.dialogueIntent = dialogueIntent(action);
  else if (action.kind === 'clip-properties') request.propertiesIntent = {side: 'timeline',
    operation: {kind: 'clip-properties', edits: action.edits}};
  else if (['connect', 'disconnect', 'insert', 'delete-node'].includes(action.kind)) request.intents = [boardIntent(action)];
  else if (['reorder', 'remove', 'split', 'copy-move', 'set-mode'].includes(action.kind)) request.intents = [trackCommand(store, action, timeline)];
  const result = createFormat5SequenceEditService(store).preview(request) as Row;
  if (!result || result.ok === false) {
    const code = String(result?.code ?? 'SEQUENCE_EDIT_CONTRACT_INVALID');
    throw new AppError(code, '格式 5 序列动作无法预览，请重新读取后再试。', 409, {ids: result?.ids ?? []});
  }
  return {envelope: result.envelope as SequenceEditEnvelope, planDigest: String(result.planDigest),
    summary: summarize(action, result.envelope as SequenceEditEnvelope, result.warnings as readonly unknown[] ?? [])};
}
/** Commit exactly the previewed envelope; repeated commits replay the receipt. */
export function commitMioSequenceAction(store: ProjectStore, plan: MioSequencePlan): SequenceEditReceipt {
  requireF5(store);
  const value = createFormat5SequenceEditService(store).commit({projectId: store.projectId,
    envelope: plan.envelope, expectedPlanDigest: plan.planDigest}) as SequenceEditReceipt;
  return value;
}
export interface MioSequenceUndoPlan {
  readonly projectId: string; readonly actionId: string; readonly requestId: string;
  readonly expected: {readonly position: number; readonly revision: number};
}
/** D5: Mio undo addresses its own action id through the same inverse-patch
 * history transaction. It never runs when the shared cursor moved, so a request
 * that already compensated cannot compensate again. */
export function prepareMioSequenceUndo(store: ProjectStore, projectId: string, requestId: string, requestedActionId?: string): MioSequenceUndoPlan {
  requireF5(store);
  projectCheck(store, projectId);
  const history = readSequenceEditHistory(store);
  const entry = history.undo;
  const actionId = requestedActionId ?? entry?.actionId;
  if (!actionId) throw new AppError('SEQUENCE_EDIT_HISTORY_CONFLICT', '还没有可撤销的 Mio 动作。', 409, {});
  const target = entry ? readSequenceEditHistoryEntry(store, entry.actionId) : null;
  if (target && target.origin !== 'mio') throw new AppError('SEQUENCE_EDIT_HISTORY_CONFLICT', '这一步不是 Mio 动作。', 409, {actionId});
  if (!entry || entry.actionId !== actionId) {
    throw new AppError('SEQUENCE_EDIT_HISTORY_CONFLICT', '这一步不是当前可撤销的 Mio 动作。', 409,
      {actionId, position: history.position, revision: history.revision});
  }
  return {projectId, actionId, requestId, expected: {position: history.position, revision: history.revision}};
}
export function applyMioSequenceUndo(store: ProjectStore, plan: MioSequenceUndoPlan): SequenceEditReceipt {
  requireF5(store);
  return createSequenceEditing(store).call('sequence.undo', plan) as SequenceEditReceipt;
}
