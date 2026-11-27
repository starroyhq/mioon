/** Bounded Mio and external write actions for format-5 sequences.
 *
 * One model action is expanded and previewed server-side into the shared
 * envelope; the tool runtime obtains approval for the stable impact, then
 * commits exactly that envelope + plan digest. The model never supplies an
 * envelope, allocation, receipt or raw generated id. External actions share
 * the preview and commit implementation with user-origin history.
 */
import {createHash, randomUUID} from 'node:crypto';
import {AppError} from '../../contracts/src/app-error.ts';
import {createFormat5SequenceEditService} from './format5-sequence-edit-service.ts';
import {MioSequencePreviewRejection} from './format5-sequence-preview-errors.ts';
import {createSequenceEditing, readSequenceEditHistory} from './sequence-edit.ts';
import {readSequenceEditHistoryEntry} from './format5-editor-history.ts';
import {readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
import {readSequenceSyncContext, sequenceSpeedImpact} from './format5-sequence-sync.ts';
import {sequenceSyncIntent} from '../../contracts/src/sequence-sync.ts';
import {MIO_SEQUENCE_ACTION_LIMITS} from '../../contracts/src/mio-sequence.ts';
import type {MioSequenceAction} from '../../contracts/src/mio-sequence.ts';
import type {BoardIntentOperation, SequenceEditDialogueEdit, SequenceEditDialogueIntent, SequenceEditEnvelope,
  SequenceEditAllocation, SequenceEditIntent, SequenceEditPrevisIntent, SequenceEditReceipt, SequenceEditReferenceIntent,
  SequenceEditSubjectIntent, SequenceEditTrackIntent} from '../../contracts/src/sequence-edit.ts';
import type {AgentTaskLocale} from '../../contracts/src/agent-tasks-v2.ts';
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
function copyIdentity(projectId: string, requestId: string, role: 'clip' | 'shot'): string {
  const bytes = createHash('sha256').update(JSON.stringify(['sequence.copy-as-new-shot', projectId, requestId, role]))
    .digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return [bytes.subarray(0, 4), bytes.subarray(4, 6), bytes.subarray(6, 8), bytes.subarray(8, 10), bytes.subarray(10)]
    .map(part => part.toString('hex')).join('-');
}
function trackCommand(store: ProjectStore, action: MioSequenceAction, requestId: string): ReturnType<typeof sequenceSyncIntent> {
  switch (action.kind) {
    case 'split-at-scenes': return sequenceSyncIntent({kind: 'clip-split-scenes',
      assetId: action.assetId, resultId: action.resultId});
    case 'reorder': return sequenceSyncIntent({kind: 'clip-move', clipId: action.clipId, beforeClipId: action.beforeClipId});
    case 'remove': return sequenceSyncIntent({kind: 'clip-remove', clipId: action.clipId});
    case 'split': return sequenceSyncIntent({kind: 'clip-split', clipId: action.clipId,
      offsetFrames: action.offsetFrames, rightClipId: randomUUID()});
    case 'copy-move': return sequenceSyncIntent({kind: 'clip-move', clipId: action.clipId,
      beforeClipId: action.beforeClipId, copyNodeId: randomUUID()});
    case 'copy-as-new-shot': return sequenceSyncIntent({kind: 'clip-copy-as-new-shot', clipId: action.clipId,
      newClipId: copyIdentity(store.projectId, requestId, 'clip'), copyNodeId: copyIdentity(store.projectId, requestId, 'shot')});
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
    case 'board-root-create': return {side: 'board', operation: {kind: 'board.root.create',
      nodeId: randomUUID(), name: action.name, position: action.position}} as SequenceEditIntent;
    case 'board-shot-append': return {side: 'board', operation: {kind: 'board.shot.append',
      nodeId: randomUUID(), name: action.name, ...(action.position ? {position: action.position} : {})}} as SequenceEditIntent;
    case 'board-layout-move': return {side: 'board', operation: {kind: 'board.layout.move',
      moves: action.moves.map(move => ({nodeId: move.nodeId, x: move.x, y: move.y}))}} as SequenceEditIntent;
    case 'board-node-create': return {side: 'board', operation: {kind: 'board.node.create',
      nodeId: randomUUID(), nodeType: action.type, name: action.name, position: action.position,
      ...(action.assetId === undefined ? {} : {assetId: action.assetId}),
      ...(action.text === undefined ? {} : {text: action.text})}} as SequenceEditIntent;
    case 'board-shot-update': return {side: 'board', operation: {kind: 'board.shot.update',
      shotId: action.shotId, expectedRevision: action.expectedRevision, patch: action.patch}} as SequenceEditIntent;
    case 'board-node-update': return {side: 'board', operation: {kind: 'board.node.update',
      nodeId: action.nodeId, expectedRevision: action.expectedRevision, patch: action.patch}} as SequenceEditIntent;
    case 'board-restore': return {side: 'board', operation: {kind: 'board.restore',
      items: action.targets}} as SequenceEditIntent;
    case 'board-duplicate': return {side: 'board', operation: {kind: 'board.duplicate',
      items: action.targets, ...(action.viewport ? {viewport: action.viewport} : {})}} as SequenceEditIntent;
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

/** A deterministic free board spot for an object the model did not place: to
 * the right of every live shot/node, on the second row the board already uses
 * for auxiliary cards. Kept inside the contract's coordinate range. */
function freeBoardPosition(store: ProjectStore): {x: number; y: number} {
  const context = readSequenceSyncContext(store);
  const right = [...context.shots.values(), ...context.nodeRows.values()].reduce((maximum, row) => {
    const value = (row as Row).position;
    if (value === null || typeof value !== 'object' || !Number.isFinite((value as Row).x)) return maximum;
    return Math.max(maximum, Number((value as Row).x));
  }, 0);
  return {x: Math.min(1_000_000, right + 340), y: 120};
}
function referenceRequest(action: MioSequenceAction): {referenceIntent: SequenceEditReferenceIntent; allocation: {edges: {id: string; fromId: string; toId: string}[]}} {
  switch (action.kind) {
    case 'reference-attach': {
      const edgeId = randomUUID();
      return {allocation: {edges: [{id: edgeId, fromId: action.sourceNodeId, toId: action.shotId}]},
        referenceIntent: {side: 'board', operation: {kind: 'reference-edge', edit: {kind: 'attach', edgeId,
          shotId: action.shotId, sourceNodeId: action.sourceNodeId, ...(action.role ? {role: action.role} : {})}}}};
    }
    case 'reference-set-role': return {allocation: {edges: []},
      referenceIntent: {side: 'board', operation: {kind: 'reference-edge', edit: {kind: 'set-role', edgeId: action.edgeId,
        shotId: action.shotId, role: action.role}}}};
    case 'reference-detach': return {allocation: {edges: []},
      referenceIntent: {side: 'board', operation: {kind: 'reference-edge', edit: {kind: 'detach', edgeId: action.edgeId,
        shotId: action.shotId}}}};
    case 'reference-reorder': return {allocation: {edges: []},
      referenceIntent: {side: 'board', operation: {kind: 'reference-edge', edit: {kind: 'reorder',
        shotId: action.shotId, edgeIds: [...action.edgeIds]}}}};
    default: throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '不是引用线动作。', 409);
  }
}
function subjectIntent(action: Extract<MioSequenceAction, {kind: 'subject-binding'}>): SequenceEditSubjectIntent {
  const edit = action.edit.kind === 'create' ? {...action.edit, bindingId: randomUUID()} : action.edit;
  return {side: 'board', operation: {kind: 'subject-binding', edit} as SequenceEditSubjectIntent['operation']};
}
function subjectCardIntent(store: ProjectStore,
  action: Extract<MioSequenceAction, {kind: 'subject-card-create' | 'subject-card-delete'}>): SequenceEditSubjectIntent {
  if (action.kind === 'subject-card-create') return {side: 'board', operation: {kind: 'subject.card.create',
    nodeId: randomUUID(), subjectId: action.subjectId, position: action.position ?? freeBoardPosition(store)}};
  return {side: 'board', operation: {kind: 'subject.card.delete', nodeId: action.nodeId}};
}
function previsIntent(store: ProjectStore,
  action: Extract<MioSequenceAction, {kind: 'previs-create' | 'previs-scene-set'}>): SequenceEditPrevisIntent {
  if (action.kind === 'previs-create') return {side: 'board', operation: {kind: 'previs-create',
    nodeId: randomUUID(), label: action.label, position: action.position ?? freeBoardPosition(store)}};
  return {side: 'board', operation: {kind: 'previs-scene-set', nodeId: action.nodeId,
    expectedSceneRevision: action.expectedSceneRevision, scene: action.scene}};
}
export interface MioSequencePlan {
  readonly envelope: SequenceEditEnvelope;
  readonly planDigest: string;
  readonly summary: {
    readonly action: string; readonly affected: readonly string[];
    readonly counts: {readonly nodes: number; readonly edges: number; readonly clips: number; readonly other: number};
    readonly warnings: number;
    readonly speed?: ReturnType<typeof sequenceSpeedImpact>;
  };
}
function summarize(action: MioSequenceAction, envelope: SequenceEditEnvelope, warnings: readonly unknown[]): MioSequencePlan['summary'] {
  const impact = envelope.impact as unknown as Row;
  const affected = [...new Set([...(impact.nodeIds ?? []), ...(impact.edgeIds ?? []), ...(impact.mainTrackClipIds ?? []),
    ...(impact.otherTrackItemIds ?? []), ...(impact.subtitleCueIds ?? []), ...(impact.trackIds ?? [])].map(String))].slice(0, 50);
  return {action: action.kind, affected,
    counts: {nodes: (impact.nodeIds ?? []).length, edges: (impact.edgeIds ?? []).length,
      clips: (impact.mainTrackClipIds ?? []).length, other: (impact.otherTrackItemIds ?? []).length + (impact.subtitleCueIds ?? []).length + (impact.trackIds ?? []).length},
    warnings: warnings.length};
}
/** Preview one bounded action and return the exact envelope to commit. The
 * optional task language reaches the server-side name expansion, so a
 * separated-sound clip and a created audio track are named in the language the
 * user talks to Mio in. */
export function previewMioSequenceAction(store: ProjectStore, projectId: string, requestId: string,
  action: MioSequenceAction, {origin = 'mio', locale, speedStep}: {
    readonly origin?: 'user' | 'mio'; readonly locale?: AgentTaskLocale;
    readonly speedStep?: {readonly actionId: string; readonly allocation?: SequenceEditAllocation};
  } = {}): MioSequencePlan {
  requireF5(store);
  projectCheck(store, projectId);
  const timeline = readFormat5TimelineRecord(store.db, 'project');
  if (!timeline) throw new AppError('SEQUENCE_EDIT_TARGET_NOT_FOUND', '项目没有格式 5 主轨。', 404);
  const request: Row = {projectId, requestId, origin, ...(locale !== undefined ? {locale} : {})};
  if (action.kind === 'subject-binding') request.subjectIntent = subjectIntent(action);
  else if (action.kind === 'subject-card-create' || action.kind === 'subject-card-delete')
    request.subjectIntent = subjectCardIntent(store, action);
  else if (action.kind === 'previs-create' || action.kind === 'previs-scene-set')
    request.previsIntent = previsIntent(store, action);
  else if (action.kind === 'reference-attach' || action.kind === 'reference-set-role'
    || action.kind === 'reference-detach' || action.kind === 'reference-reorder') {
    const reference = referenceRequest(action);
    request.referenceIntent = reference.referenceIntent;
    request.allocation = reference.allocation;
  }
  else if (action.kind === 'subtitles') request.subtitlesIntent = {side: 'timeline', operation: {kind: 'subtitles',
    edits: action.edits.map(edit => edit.kind === 'add' ? {kind: 'add' as const, cue: {...edit.cue, id: randomUUID()}}
      : edit)}};
  else if (action.kind === 'dialogue') request.dialogueIntent = dialogueIntent(action);
  else if (action.kind === 'clip-properties') request.propertiesIntent = {side: 'timeline',
    operation: {kind: 'clip-properties', edits: action.edits}};
  else if (action.kind === 'replace-source') {
    const clip = timeline.clips.find(item => item.id === action.clipId);
    if (!clip) throw new MioSequencePreviewRejection('SEQUENCE_EDIT_TARGET_NOT_FOUND', '片段不属于当前格式 5 时间线。', 404, {clipId: action.clipId});
    if (clip.sourceState !== 'ready') throw new MioSequencePreviewRejection('INVALID_MEDIA', '仅可替换已就绪片段的来源。', 409, {clipId: clip.id});
    if (clip.assetId === action.assetId) throw new MioSequencePreviewRejection('SEQUENCE_EDIT_NOOP', '片段已经使用此素材。', 409, {clipId: clip.id});
    if (clip.sequenceSource?.kind === 'shot') {
      const versionId = action.versionId;
      if (!versionId || !store.db.prepare(
        "SELECT 1 FROM project.versions WHERE id=? AND projectId=? AND json_extract(data,'$.assetId')=?",
      ).get(versionId, projectId, action.assetId)) {
        throw new MioSequencePreviewRejection('INVALID_MEDIA', '主轨镜头必须指定对应素材的镜头版本。', 409, {clipId: clip.id});
      }
      request.intents = [sequenceSyncIntent({kind: 'clip-version', clipId: clip.id, versionId, mode: 'locked'})];
    } else {
      const sourceReplacement = {assetId: action.assetId, ...(action.versionId === undefined ? {} : {versionId: action.versionId})};
      request.propertiesIntent = {side: 'timeline',
        operation: {kind: 'clip-properties', edits: [{clipId: clip.id, patch: {sourceReplacement}}]}};
    }
  }
  else if (action.kind === 'separate-sound') request.soundIntent = {side: 'timeline',
    operation: {kind: 'separate-sound', clipId: action.clipId}};
  else if (action.kind === 'clip-speed' || action.kind === 'freeze-frame') {
    request.speedIntent = {side: 'timeline', operation: action};
    if (speedStep) {
      request.actionId = speedStep.actionId;
      if (speedStep.allocation) request.allocation = speedStep.allocation;
    }
  }
  else if (action.kind === 'format-set') request.formatIntent = {side: 'timeline',
    operation: {kind: 'timeline-format', presetId: action.presetId}};
  else if (action.kind === 'track-add') request.trackIntent = {side: 'timeline',
    operation: {kind: 'track-structure', edit: {kind: 'add', trackId: randomUUID(), trackKind: action.trackKind,
      ...(action.name ? {name: action.name} : {})}}} satisfies SequenceEditTrackIntent;
  else if (action.kind === 'track-update') request.trackIntent = {side: 'timeline',
    operation: {kind: 'track-structure', edit: {kind: 'update', trackId: action.trackId, patch: action.patch}}};
  else if (['connect', 'disconnect', 'insert', 'delete-node', 'board-root-create', 'board-shot-append', 'board-layout-move',
    'board-node-create', 'board-shot-update', 'board-node-update', 'board-restore', 'board-duplicate'].includes(action.kind)) request.intents = [boardIntent(action)];
  else if (action.kind === 'insert-asset') request.intents = [sequenceSyncIntent({kind: 'insert-asset',
    assetId: action.assetId, trackId: action.trackId, startFrame: action.startFrame})];
  else if (['reorder', 'remove', 'split', 'copy-move', 'copy-as-new-shot', 'set-mode', 'split-at-scenes'].includes(action.kind))
    request.intents = [trackCommand(store, action, requestId)];
  else if (action.kind === 'generate') request.generateIntent = {side: 'timeline', operation: {kind: 'generate-placeholder',
    placement: action.placement, shotId: randomUUID(), clipId: randomUUID(), title: action.title ?? 'Mio 剪辑生成',
    // The confirmed action places and submits in one commit using the frozen request id.
    submit: true,
    settings: {requestId: `${origin === 'mio' ? 'mio' : 'cli'}-${requestId}`.slice(0, 200), providerId: action.providerId, model: action.model,
      region: action.region, prompt: action.prompt, aspectRatio: action.aspectRatio, duration: action.duration,
      ...(action.parameters ? {parameters: action.parameters} : {}),
      ...(action.connectionId ? {connectionId: action.connectionId} : {}),
      ...(action.configurationRevision !== undefined ? {configurationRevision: action.configurationRevision} : {}),
      ...(action.modelEntryId ? {modelEntryId: action.modelEntryId} : {})}}};
  const result = createFormat5SequenceEditService(store).preview(request);
  if ('ok' in result) {
    throw new MioSequencePreviewRejection(result.code, result.message ?? '格式 5 序列动作无法预览，请重新读取后再试。', 409,
      {ids: result.ids, ...(result.reason ? {reason: result.reason} : {}),
        ...(result.dialogueConflict ? {dialogueConflict: result.dialogueConflict} : {})});
  }
  const {warnings} = result;
  if (action.kind === 'replace-source' && warnings.some(warning => warning.code === 'SOURCE_TOO_SHORT' && warning.clipId === action.clipId)) {
    throw new MioSequencePreviewRejection('SEQUENCE_EDIT_CLIP_PROPERTIES_INVALID', '新来源不够长，无法保留片段的入点和长度。', 409, {clipId: action.clipId});
  }
  const summary = summarize(action, result.envelope, warnings);
  if (!result.envelope.speedIntent) return {envelope: result.envelope, planDigest: result.planDigest, summary};
  const impact = sequenceSpeedImpact(store, result.envelope);
  const limit = MIO_SEQUENCE_ACTION_LIMITS.maxTargets;
  return {envelope: result.envelope, planDigest: result.planDigest, summary: {...summary, speed: {
    durationFrames: impact.durationFrames, movedClipIds: impact.movedClipIds.slice(0, limit),
    changedAnchorIds: impact.changedAnchorIds.slice(0, limit),
  }}};
}
/** Commit exactly the previewed envelope; repeated commits replay the receipt. */
export function commitMioSequenceAction(store: ProjectStore, plan: MioSequencePlan,
  options: {readonly generationSubmit?: (input: any) => unknown;
    readonly recordSpeedReceiptInside?: (receipt: SequenceEditReceipt) => void} = {}): SequenceEditReceipt {
  requireF5(store);
  const value = createFormat5SequenceEditService(store, options).commit({projectId: store.projectId,
    envelope: plan.envelope, expectedPlanDigest: plan.planDigest}) as SequenceEditReceipt;
  return value;
}
export interface MioSequenceUndoPlan {
  readonly projectId: string; readonly actionId: string; readonly requestId: string;
  readonly expected: {readonly position: number; readonly revision: number};
  readonly origin: 'mio';
}
/** D5: Mio undo addresses its own action id through the same inverse-patch
 * history transaction. It never runs when the shared cursor moved, so a request
 * that already compensated cannot compensate again. */
export function prepareMioSequenceUndo(store: ProjectStore, projectId: string, requestId: string, requestedActionId?: string): MioSequenceUndoPlan {
  requireF5(store);
  projectCheck(store, projectId);
  const history = readSequenceEditHistory(store, 'mio');
  const entry = history.undo;
  const actionId = requestedActionId ?? entry?.actionId;
  if (!actionId) throw new AppError('SEQUENCE_EDIT_HISTORY_CONFLICT', '还没有可撤销的 Mio 动作。', 409, {});
  if (!entry || entry.actionId !== actionId) {
    throw new AppError('SEQUENCE_EDIT_HISTORY_CONFLICT', '这一步不是当前可撤销的 Mio 动作。', 409,
      {actionId, position: history.position, revision: history.revision, reason: 'STACK_TOP'});
  }
  if (history.undoBlockedBy !== null) {
    throw new AppError('SEQUENCE_EDIT_HISTORY_CONFLICT', '之后还有用户动作，Mio 不能越过它撤销。', 409,
      {actionId, reason: 'USER_ACTION_ABOVE', blockedBy: history.undoBlockedBy,
        position: history.position, revision: history.revision});
  }
  const target = readSequenceEditHistoryEntry(store, actionId);
  if (target?.origin !== 'mio') throw new AppError('SEQUENCE_EDIT_HISTORY_CONFLICT', '这一步不是 Mio 动作。', 409, {actionId});
  return {projectId, actionId, requestId, origin: 'mio', expected: {position: history.position, revision: history.revision}};
}
export function applyMioSequenceUndo(store: ProjectStore, plan: MioSequenceUndoPlan): SequenceEditReceipt {
  requireF5(store);
  return createSequenceEditing(store).call('sequence.undo', plan) as SequenceEditReceipt;
}
