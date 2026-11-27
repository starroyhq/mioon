/** One public RPC seam for format-5 sequence editing.
 *
 * UI-B2, UI-E2 and MT all call `sequence.preview` / `sequence.commit`; the
 * confirmed intent routes to its owning coordinator:
 * - board intents -> `sequence-edit.ts` (CS),
 * - timeline intents -> `format5-sequence-sync.ts` (TS),
 * - subject binding -> the subject planner inside the shared TS transaction,
 * - previs create/save -> the previs planner and its board-node transaction,
 * History, undo and redo have exactly one implementation in the CS
 * coordinator (`format5-editor-history.ts`), including eviction/atEarliest.
 */
import {randomUUID} from 'node:crypto';
import {AppError} from '../../contracts/src/app-error.ts';
import type {SequenceEditAllocation, SequenceEditEnvelope, SequenceEditHistoryCursor, SequenceEditImpact,
  SequenceEditIntent, SequenceEditReceipt, SequenceEditReferenceIntent, SequenceEditSubjectIntent} from '../../contracts/src/sequence-edit.ts';
import {isSequenceEditEnvelope} from '../../contracts/src/sequence-edit.ts';
import {sequenceEditInputDigest} from './format5-editor-history.ts';
import type {SequenceSyncCommand} from '../../contracts/src/sequence-sync.ts';
import {sequenceEditIntentPayloadSchema} from '../../contracts/src/sequence-editing.ts';
import {assertProjectStore} from './store-runtime.ts';
import type {ProjectStore} from './project-file/store.ts';
import {
  applySequenceEdit, createSequenceEditing, planSequenceEditIntents, previewSequenceBoardAction, readSequenceEditContext,
} from './sequence-edit.ts';
import {previewSequenceSpeed, previewSequenceSync, readSequenceSyncContext, runSequenceSync} from './format5-sequence-sync.ts';
import {sequenceEditPreviewFailure, type SequenceEditPreviewFailure} from './format5-sequence-preview-errors.ts';
import {
  buildSubjectBindingEnvelope, planSubjectBindingAction,
} from './format5-subject-binding.ts';
import {
  buildSubjectCardEnvelope, planSubjectEditAction, readSubjectCardProjection,
} from './format5-subject-card.ts';
import type {SubjectCardCommand} from './format5-subject-card.ts';
import {
  buildReferenceEdgeEnvelope, planReferenceEdgeAction,
} from './format5-reference-inputs.ts';
import {previewClipProperties, runClipPropertiesSync} from './format5-clip-properties.ts';
import {previewSeparateSound, runSeparateSoundSync} from './format5-clip-sound.ts';
import {previewTimelineFormat, runTimelineFormatSync} from './format5-format-set.ts';
import {previewTrack, runTrackSync} from './format5-tracks.ts';
import {previewGenerateInEditing} from './format5-sequence-sync.ts';
import {previewPrevisAction} from './format5-previs.ts';
import {previewSubtitleEdits, runSubtitleEditsSync} from './format5-subtitle-edits.ts';
import {previewDialogueAction, runDialogueAction} from './format5-dialogue.ts';
import {prepareSequenceEditHistory} from './format5-editor-history.ts';
import {readProjectContentStamp} from './project-file/content-stamp.ts';
import {isSequenceProjectFormat} from './project-file/schema/databases.ts';
import {readFormat5TimelineRecord} from './project-file/format5-timeline.ts';
import {deriveFilmChains} from '../../contracts/src/board-sequence.ts';
import {isBoardIntentOperation} from '../../contracts/src/sequence-edit.ts';
import {isLocale} from '../../i18n/src/index.ts';

type Row = Record<string, any>;
type SequenceEditPreview = SequenceEditPreviewFailure | {
  readonly envelope: SequenceEditEnvelope;
  readonly planDigest: string;
  readonly warnings: readonly {readonly code: string; readonly clipId?: string}[];
};
const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[a-f0-9]{12}$/iu.test(value);
const format5 = (store: ProjectStore): boolean =>
  isSequenceProjectFormat(Number(store.db.prepare('PRAGMA project.user_version').get()?.user_version));
const requireFormat5 = (store: ProjectStore): void => {
  if (!format5(store)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '这个操作只适用于格式 5 项目。', 409, {reason: 'FORMAT_REQUIRED'});
};
const projectCheck = (store: ProjectStore, projectId: string): void => {
  if (projectId !== store.projectId) throw new AppError('PROJECT_ID_MISMATCH', '项目地址与请求不一致。', 409);
};
const failure = (code: string, ids: readonly string[] = []): {ok: false; code: string; ids: readonly string[]} =>
  ({ok: false, code, ids});
const historyState = (store: ProjectStore) => {
  const prepared = prepareSequenceEditHistory(store);
  return {epoch: prepared.state.epoch, position: prepared.state.position, revision: prepared.state.revision};
};
function emptyAllocation(): SequenceEditAllocation {
  return {clips: [], nodes: [], splitClips: [], edges: []};
}
function allocationOf(input: {allocation?: Record<string, any>}): SequenceEditAllocation {
  const value = input.allocation ?? {};
  const list = (key: string, shape: (item: any) => boolean) => Array.isArray(value[key]) ? value[key].filter(shape) : [];
  const out = emptyAllocation();
  const int = (item: any) => item && typeof item === 'object';
  (out.clips as any[]).push(...list('clips', int));
  (out.nodes as any[]).push(...list('nodes', int));
  (out.splitClips as any[]).push(...list('splitClips', int));
  (out.edges as any[]).push(...list('edges', int));
  return out;
}

/** Inverse of `sequenceSyncIntent` for the timeline route. */
function commandFromIntent(intent: SequenceEditIntent): SequenceSyncCommand | null {
  const operation = intent.operation;
  if (operation.kind === 'sync-board') return {kind: 'sync-board', ...(operation.newClipIds ? {newClipIds: operation.newClipIds} : {})};
  if (operation.kind === 'board-version') return {kind: 'board-version', nodeId: operation.nodeId, versionId: operation.version?.id ?? null};
  if (operation.kind !== 'track') return null;
  const edit = operation.edit;
  switch (edit.kind) {
    case 'add': return {kind: 'clip-add', clip: {id: edit.clip.id, nodeId: edit.clip.nodeId,
        segmentGroupId: edit.clip.splitGroupId ?? edit.clip.id, startFrame: edit.clip.startFrame,
        durationFrames: edit.clip.durationFrames, sourceInFrame: edit.clip.sourceInFrame,
        versionId: edit.clip.versionId, locked: edit.clip.versionLocked},
      beforeClipId: edit.beforeClipId, ...(edit.nodeKind ? {nodeKind: edit.nodeKind} : {}),
      ...(edit.nodeAssetId ? {nodeAssetId: edit.nodeAssetId} : {}),
      ...(edit.nodeName ? {nodeName: edit.nodeName} : {}),
      ...(edit.copyFromClipId ? {copyFromClipId: edit.copyFromClipId} : {})};
    case 'insert-asset': return {kind: 'insert-asset', assetId: edit.assetId, trackId: edit.trackId,
      startFrame: edit.startFrame};
    case 'paste-clip': return {kind: 'paste-clip', clipId: edit.clipId, startFrame: edit.startFrame};
    case 'copy-as-new-shot': return {kind: 'clip-copy-as-new-shot', clipId: edit.clipId,
      newClipId: edit.newClipId, copyNodeId: edit.copyNodeId};
    case 'split-at-scenes': return {kind: 'clip-split-scenes', assetId: edit.assetId, resultId: edit.resultId};
    case 'split': return {kind: 'clip-split', clipId: edit.clipId, offsetFrames: edit.offsetFrames,
      rightClipId: edit.rightClipId, ...(edit.rightSourceInFrame === undefined ? {} : {rightSourceInFrame: edit.rightSourceInFrame})};
    case 'trim': return {kind: 'clip-trim', clipId: edit.clipId, durationFrames: edit.durationFrames,
      ...(edit.sourceInFrame === undefined ? {} : {sourceInFrame: edit.sourceInFrame})};
    case 'version': return {kind: 'clip-version', clipId: edit.clipId, versionId: edit.version?.id ?? null,
      mode: edit.locked ? 'locked' : 'follow'};
    case 'remove': return {kind: 'clip-remove', clipId: edit.clipId};
    case 'move': return {kind: 'clip-move', clipId: edit.clipId, beforeClipId: edit.beforeClipId,
      ...(edit.copyNodeId ? {copyNodeId: edit.copyNodeId} : {})};
    case 'move-off-track': return {kind: 'clip-move-off-track', clipId: edit.clipId, trackId: edit.trackId,
      startFrame: edit.startFrame, ...(edit.copyNodeId ? {copyNodeId: edit.copyNodeId} : {})};
    default: return null;
  }
}
const timelineIntent = (intent: SequenceEditIntent): boolean =>
  intent.operation.kind === 'track' || intent.operation.kind === 'sync-board' || intent.operation.kind === 'board-version';
const boardIntent = (intent: SequenceEditIntent): boolean => intent.operation.kind === 'board'
  || isBoardIntentOperation(intent.operation);

function subjectCommand(intent: SequenceEditSubjectIntent): {
  readonly kind: 'create' | 'set-mode' | 'detach' | 'restore'; readonly bindingId: string;
  readonly shotId?: string; readonly subjectId?: string; readonly role?: 'subject' | 'style';
  readonly bindingMode?: 'follow' | 'locked'; readonly subjectVersionId?: string | null;
} {
  if (intent.operation.kind !== 'subject-binding') throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '主体绑定动作无效。', 409);
  const edit: any = intent.operation.edit;
  switch (edit.kind) {
    case 'create': return {kind: 'create', bindingId: edit.bindingId, shotId: edit.shotId,
      subjectId: edit.subjectId, role: edit.role};
    case 'set-mode': return {kind: 'set-mode', bindingId: edit.bindingId, bindingMode: edit.bindingMode,
      subjectVersionId: edit.subjectVersionId};
    case 'detach': return {kind: 'detach', bindingId: edit.bindingId};
    case 'restore': return {kind: 'restore', bindingId: edit.bindingId, bindingMode: edit.bindingMode,
      subjectVersionId: edit.subjectVersionId};
    default: throw new AppError('SEQUENCE_EDIT_SUBJECT_BINDING_INVALID', '主体绑定动作无效。', 409);
  }
}

function subjectCardCommand(operation: import('../../contracts/src/sequence-edit.ts').SubjectCardOperation): SubjectCardCommand {
  switch (operation.kind) {
    case 'subject.card.create': return {kind: 'card-create', nodeId: operation.nodeId,
      subjectId: operation.subjectId, position: operation.position};
    case 'subject.card.delete': return {kind: 'card-delete', nodeId: operation.nodeId};
  }
}

export function createFormat5SequenceEditService(store: ProjectStore, options: {
  readonly clipboardOwner?: object;
  readonly generationSubmit?: (input: any) => unknown;
  readonly recordSpeedReceiptInside?: (receipt: SequenceEditReceipt) => void;
} = {}): {
  preview(input: any): SequenceEditPreview;
  commit(input: any): unknown;
  history(input: {projectId: string}): unknown;
  board(input: {projectId: string}): unknown;
  undo(input: any): unknown;
  redo(input: any): unknown;
} {
  assertProjectStore(store);
  const coordinator = createSequenceEditing(store);

  function subjectPreview(input: any): SequenceEditPreview {
    const intent = input.subjectIntent as SequenceEditSubjectIntent;
    const state = historyState(store);
    if (intent.operation.kind !== 'subject-binding') {
      const envelope = {...buildSubjectCardEnvelope(store, subjectCardCommand(intent.operation), {
        requestId: input.requestId, actionId: input.actionId ?? randomUUID(), epoch: state.epoch,
        historyPosition: state.position, historyRevision: state.revision,
        ...(input.origin ? {origin: input.origin} : {})}), ...(input.origin ? {origin: input.origin} : {})};
      try { planSubjectEditAction(store, envelope); }
      catch (error) {
        if (error instanceof AppError) return sequenceEditPreviewFailure(error);
        throw error;
      }
      return {envelope, planDigest: sequenceEditInputDigest(envelope), warnings: []};
    }
    const command = subjectCommand(intent);
    const edgeId = (input.allocation?.edges ?? []).find((edge: Row) => uuid(edge?.id))?.id as string | undefined
      ?? randomUUID();
    try {
      const envelope: SequenceEditEnvelope = {...buildSubjectBindingEnvelope(store as never, command as never, {
        requestId: input.requestId, actionId: input.actionId ?? randomUUID(), epoch: state.epoch,
        historyPosition: state.position, historyRevision: state.revision, edgeId}), ...(input.origin ? {origin: input.origin} : {})};
      planSubjectBindingAction(store as never, envelope);
      return {envelope, planDigest: sequenceEditInputDigest(envelope), warnings: []};
    } catch (error) {
      if (error instanceof AppError) return sequenceEditPreviewFailure(error);
      throw error;
    }
  }

  function referencePreview(input: any): SequenceEditPreview {
    const intent = input.referenceIntent as SequenceEditReferenceIntent;
    const edit: any = intent.operation.edit;
    const state = historyState(store);
    const allocation = allocationOf(input);
    const edgeId = edit.kind === 'attach'
      ? (allocation.edges.find(edge => edge.id === edit.edgeId && edge.toId === edit.shotId)?.id
        ?? allocation.edges.find(edge => edge.toId === edit.shotId)?.id
        ?? randomUUID())
      : edit.edgeId;
    const command = edit.kind === 'attach'
      ? {kind: 'attach' as const, edgeId, shotId: edit.shotId, sourceNodeId: edit.sourceNodeId,
        ...(edit.role ? {role: edit.role} : {})}
      : edit.kind === 'set-role'
        ? {kind: 'set-role' as const, edgeId, shotId: edit.shotId, role: edit.role}
        : edit.kind === 'reorder'
          ? {kind: 'reorder' as const, shotId: edit.shotId, edgeIds: edit.edgeIds}
          : {kind: 'detach' as const, edgeId, shotId: edit.shotId};
    try {
      const envelope: SequenceEditEnvelope = {...buildReferenceEdgeEnvelope(store, command, {
        requestId: input.requestId, actionId: input.actionId ?? randomUUID(), epoch: state.epoch,
        historyPosition: state.position, historyRevision: state.revision}), ...(input.origin ? {origin: input.origin} : {})};
      planReferenceEdgeAction(store, envelope);
      return {envelope, planDigest: sequenceEditInputDigest(envelope), warnings: []};
    } catch (error) {
      if (error instanceof AppError) return sequenceEditPreviewFailure(error);
      throw error;
    }
  }

  function timelinePreview(input: any, intents: SequenceEditIntent[]): SequenceEditPreview {
    if (intents.length !== 1) return failure('SEQUENCE_EDIT_CONTRACT_INVALID', []);
    const command = commandFromIntent(intents[0]!);
    if (!command) return failure('SEQUENCE_EDIT_CONTRACT_INVALID', []);
    return previewSequenceSync(store, command, {requestId: input.requestId,
      ...(input.actionId ? {actionId: input.actionId} : {}), ...(input.origin ? {origin: input.origin} : {})});
  }

  function boardPreview(input: any, intents: SequenceEditIntent[]): SequenceEditPreview {
    const context = readSequenceEditContext(store as never);
    const state = historyState(store);
    const content = readProjectContentStamp(store.db).contentSequence;
    let prepared: ReturnType<typeof previewSequenceBoardAction>;
    try { prepared = previewSequenceBoardAction(store, intents, allocationOf(input), options.clipboardOwner); }
    catch (error) {
      if (error instanceof AppError) return sequenceEditPreviewFailure(error);
      throw error;
    }
    if (prepared.ok === false) return prepared;
    const envelope: SequenceEditEnvelope = {
      contractVersion: 1, projectId: store.projectId, epoch: state.epoch,
      actionId: input.actionId ?? randomUUID(), requestId: input.requestId, originSide: intents[0]!.side,
      filmId: context.rootNodeId, intents, ...(input.origin ? {origin: input.origin} : {}),
      baseline: {contentRevision: content, timelineRevision: context.timeline.revision,
        syncRevision: context.syncRevision, historyPosition: state.position,
        historyRevision: state.revision, targets: []},
      impact: prepared.impact, allocation: prepared.allocation,
    };
    if (!isSequenceEditEnvelope(envelope)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID', []);
    return {envelope, planDigest: sequenceEditInputDigest(envelope), warnings: prepared.warnings};
  }

  function preview(input: any): SequenceEditPreview {
    projectCheck(store, input.projectId);
    requireFormat5(store);
    // Timeline preview currently owns its own read transaction; subject and
    // board previews only read, so no outer transaction is needed here.
    if (input.speedIntent) return previewSequenceSpeed(store, {requestId: input.requestId,
      ...(input.actionId ? {actionId: input.actionId} : {}), ...(input.origin ? {origin: input.origin} : {}),
      speedIntent: input.speedIntent, ...(input.allocation ? {allocation: allocationOf(input)} : {})});
    if (input.generateIntent) return previewGenerateInEditing(store, {requestId: input.requestId,
      ...(input.actionId ? {actionId: input.actionId} : {}), ...(input.origin ? {origin: input.origin} : {}),
      generateIntent: input.generateIntent as never});
    if (input.formatIntent) return previewTimelineFormat(store, {requestId: input.requestId,
      ...(input.actionId ? {actionId: input.actionId} : {}), ...(input.origin ? {origin: input.origin} : {}),
      formatIntent: input.formatIntent as never});
    if (input.previsIntent) return previewPrevisAction(store, {requestId: input.requestId,
      ...(input.actionId ? {actionId: input.actionId} : {}), ...(input.origin ? {origin: input.origin} : {}),
      previsIntent: input.previsIntent as never});
    if (input.subtitlesIntent) return previewSubtitleEdits(store, {requestId: input.requestId,
      ...(input.actionId ? {actionId: input.actionId} : {}), ...(input.origin ? {origin: input.origin} : {}),
      subtitlesIntent: input.subtitlesIntent as never});
    if (input.dialogueIntent) return previewDialogueAction(store, {requestId: input.requestId,
      ...(input.actionId ? {actionId: input.actionId} : {}), ...(input.origin ? {origin: input.origin} : {}),
      dialogueIntent: input.dialogueIntent as never});
    if (input.trackIntent) return previewTrack(store, {requestId: input.requestId,
      ...(input.actionId ? {actionId: input.actionId} : {}), ...(input.origin ? {origin: input.origin} : {}),
      trackIntent: input.trackIntent as never});
    if (input.propertiesIntent) return previewClipProperties(store, {requestId: input.requestId,
      ...(input.actionId ? {actionId: input.actionId} : {}), ...(input.origin ? {origin: input.origin} : {}),
      propertiesIntent: input.propertiesIntent as never});
    if (input.soundIntent) {
      // The caller's language only expands the generated names; it never
      // becomes part of the envelope, so previewing again reproduces the rows.
      const locale = isLocale(input.locale) ? input.locale : undefined;
      return previewSeparateSound(store, {requestId: input.requestId,
        ...(input.actionId ? {actionId: input.actionId} : {}), ...(input.origin ? {origin: input.origin} : {}),
        soundIntent: input.soundIntent as never, ...(locale !== undefined ? {locale} : {})});
    }
    if (input.subjectIntent) return subjectPreview(input);
    if (input.referenceIntent) return referencePreview(input);
    const intents = (input.intents ?? []) as SequenceEditIntent[];
    if (intents.length === 0) return failure('SEQUENCE_EDIT_CONTRACT_INVALID', []);
    for (const intent of intents) {
      if (!sequenceEditIntentPayloadSchema.safeParse(intent).success) return failure('SEQUENCE_EDIT_CONTRACT_INVALID', []);
    }
    if (intents.some(boardIntent)) {
      if (intents.some(timelineIntent)) return failure('SEQUENCE_EDIT_CONTRACT_INVALID', []);
      return boardPreview(input, intents);
    }
    if (intents.some(timelineIntent)) return timelinePreview(input, intents);
    return failure('SEQUENCE_EDIT_CONTRACT_INVALID', []);
  }

  function commit(input: any): unknown {
    projectCheck(store, input.projectId);
    requireFormat5(store);
    const envelope = input.envelope as SequenceEditEnvelope;
    if (!isSequenceEditEnvelope(envelope)) throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '动作 envelope 无效。', 409);
    const actualDigest = sequenceEditInputDigest(envelope);
    if (input.expectedPlanDigest !== actualDigest) throw new AppError('SEQUENCE_EDIT_PATCH_INVALID', '确认的计划已变化，请重新预览。', 409);
    const intents = envelope.intents;
    if (envelope.speedIntent) {
      const result = runSequenceSync(store, envelope, {expectedPlanDigest: input.expectedPlanDigest,
        ...(options.recordSpeedReceiptInside ? {recordSpeedReceiptInside: options.recordSpeedReceiptInside} : {})});
      if (!result.ok) throw new AppError(result.code, '变速编辑未完成。', 409, {ids: result.ids});
      return result.receipt;
    }
    if (envelope.generateIntent) {
      const operation = envelope.generateIntent.operation;
      // Only the explicit submit flag submits: UI placements leave it unset and
      // the UI sequence service has no generationSubmit port at all, so opening
      // the panel can never become a paid call. Mio's approved action sets it.
      const submit = operation.kind === 'generate-placeholder' && operation.submit === true;
      if (submit && (!operation.settings.providerId || !operation.settings.model || !operation.settings.region)) {
        throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '生成提交缺少服务。', 409);
      }
      const result = runSequenceSync(store, envelope, {expectedPlanDigest: input.expectedPlanDigest,
        ...(submit && options.generationSubmit ? {afterApply: () => {
          options.generationSubmit!({shotId: operation.shotId, expectedRevision: 1,
            requestId: operation.settings.requestId, providerId: operation.settings.providerId,
            model: operation.settings.model, parameters: operation.settings.parameters ?? {},
            ...(operation.settings.connectionId ? {connectionId: operation.settings.connectionId} : {}),
            ...(operation.settings.configurationRevision !== undefined
              ? {configurationRevision: operation.settings.configurationRevision} : {}),
            ...(operation.settings.modelEntryId ? {modelEntryId: operation.settings.modelEntryId} : {})});
        }} : {})}) as any;
      if (result.ok === false) throw new AppError(result.code, '格式 5 剪辑里生成没有完成。', 409, {ids: result.ids});
      return result.receipt;
    }
    if (envelope.formatIntent) {
      const result = runTimelineFormatSync(store, envelope) as any;
      if (result.ok === false) throw new AppError(result.code, '格式 5 画幅没有完成。', 409, {ids: result.ids});
      return result.receipt;
    }
    if (envelope.subtitlesIntent) {
      const result = runSubtitleEditsSync(store, envelope) as any;
      if (result.ok === false) throw new AppError(result.code, '格式 5 字幕编辑没有完成。', 409, {ids: result.ids});
      return result.receipt;
    }
    if (envelope.dialogueIntent) {
      const result = runDialogueAction(store, envelope);
      if (result.ok === false) throw new AppError(result.code, result.message ?? '格式 5 台词没有完成。', 409,
        {ids: result.ids, ...(result.dialogueConflict ? {dialogueConflict: result.dialogueConflict} : {})});
      return result.receipt;
    }
    if (envelope.trackIntent) {
      const result = runTrackSync(store, envelope) as any;
      if (result.ok === false) throw new AppError(result.code, '格式 5 轨道编辑没有完成。', 409, {ids: result.ids});
      return result.receipt;
    }
    if (envelope.propertiesIntent) {
      const result = runClipPropertiesSync(store, envelope) as any;
      if (result.ok === false) throw new AppError(result.code, '格式 5 片段属性没有完成。', 409, {ids: result.ids});
      return result.receipt;
    }
    if (envelope.soundIntent) {
      const result = runSeparateSoundSync(store, envelope) as any;
      if (result.ok === false) throw new AppError(result.code, '格式 5 分离声音没有完成。', 409, {ids: result.ids});
      return result.receipt;
    }
    if (envelope.subjectIntent || envelope.referenceIntent || envelope.previsIntent || intents.some(timelineIntent)) {
      const result = runSequenceSync(store, envelope, {expectedPlanDigest: input.expectedPlanDigest});
      if (result.ok === false) throw new AppError(result.code, result.message ?? '格式 5 同步没有完成。', 409,
        {ids: result.ids, ...(result.dialogueConflict ? {dialogueConflict: result.dialogueConflict} : {})});
      return result.receipt;
    }
    if (intents.some(boardIntent)) {
      const receipt = applySequenceEdit(store, envelope, () => {}, options.clipboardOwner);
      return receipt;
    }
    throw new AppError('SEQUENCE_EDIT_CONTRACT_INVALID', '没有可执行的 intent。', 409);
  }

  function history(input: {projectId: string}): unknown {
    projectCheck(store, input.projectId);
    requireFormat5(store);
    return coordinator.call('sequence.history.get', input);
  }
  function board(input: {projectId: string}): unknown {
    projectCheck(store, input.projectId);
    requireFormat5(store);
    const context = readSequenceSyncContext(store);
    const chain = deriveFilmChains(context.board).chains.find(item => item.filmId === context.rootNodeId);
    const chainNodeIds = chain?.nodeIds ?? [];
    const mainTrackId = context.timeline.mainTrack.trackId;
    const trackNodeIds: string[] = [];
    for (const clip of [...context.timeline.clips].filter(item => item.trackId === mainTrackId)
      .sort((left, right) => left.startFrame - right.startFrame || left.id.localeCompare(right.id))) {
      const nodeId = clip.sequenceSource?.nodeId;
      if (typeof nodeId === 'string' && trackNodeIds.at(-1) !== nodeId) trackNodeIds.push(nodeId);
    }
    const positionOf = (row: Row | undefined): {x: number; y: number} | null => {
      const value = row?.position;
      return value !== null && typeof value === 'object' && Number.isFinite((value as Row).x) && Number.isFinite((value as Row).y)
        ? {x: Number((value as Row).x), y: Number((value as Row).y)} : null;
    };
    const nameOf = (row: Row, kind: 'shot' | 'node'): string => {
      const value = kind === 'shot' ? row.title : row.name ?? row.label ?? row.text;
      return typeof value === 'string' && value ? value : kind === 'shot' ? 'Shot' : 'Node';
    };
    const archived = [
      ...[...context.archivedShots].map(([id, row]) => ({id, kind: 'shot' as const, name: nameOf(row, 'shot'), position: positionOf(row)})),
      ...[...context.archivedNodes].map(([id, row]) => ({id, kind: 'node' as const, name: nameOf(row, 'node'), position: positionOf(row)})),
    ].sort((left, right) => left.id.localeCompare(right.id));
    const subjectBoard = readSubjectCardProjection(store);
    return {projectId: store.projectId, timelineRevision: context.timeline.revision,
      syncRevision: context.syncRevision,
      inSync: chainNodeIds.length === trackNodeIds.length && chainNodeIds.every((id, index) => id === trackNodeIds[index]),
      archived, subjects: subjectBoard.subjects, bindings: subjectBoard.bindings};
  }
  function undo(input: any): unknown { return coordinator.call('sequence.undo', input); }
  function redo(input: any): unknown { return coordinator.call('sequence.redo', input); }
  return {preview, commit, history, board, undo, redo};
}

/** Read-only projection for UI-B2/UI-E2 mounting. */
export function readFormat5SequenceProjection(store: ProjectStore): unknown {
  assertProjectStore(store);
  requireFormat5(store);
  return readFormat5TimelineRecord(store.db, 'project');
}
