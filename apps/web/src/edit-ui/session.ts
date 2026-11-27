/** UI-E2 wiring for format-5 sequence editing.
 *
 * This module owns the confirm/commit handshake only: preview one exact TS
 * command, keep its envelope + plan digest, and commit that same envelope. It
 * never builds a receipt or history row and never writes project data itself.
 * Format 3/4 callers are untouched.
 */
import type {AppShot, AppTimeline, AppTimelineClip, AppVersion} from '../App.tsx';
import type {EditUiCopyMoveRequest} from './CopyMoveConfirmDialog.tsx';
import type {EditUiInspectorSequence} from './status.tsx';
import {projectEditUi} from './projection.ts';
import type {EditUiProjection, EditUiTimeline, EditUiVersion} from './projection.ts';
import {sequenceSyncIntent} from '../../../../packages/contracts/src/sequence-sync.ts';
import type {SequenceSyncCommand} from '../../../../packages/contracts/src/sequence-sync.ts';
import type {SequenceEditEnvelope, SequenceEditReceipt, SequenceEditTrackIntent} from '../../../../packages/contracts/src/sequence-edit.ts';
import {classifyCommitFailure, extractSequenceErrorIds, extractSequenceErrorReason, LostResponseState, parseSequenceCommit, UNCONFIRMED_CODE} from './lost-response.ts';
import type {LostResponseOptions, LostResponseView, LostRetryResult} from './lost-response.ts';
import {message, renderMessage, sequenceEditFailureMessageKey} from '../../../../packages/i18n/src/index.ts';
import {timelineHistoryOperationMessage} from '../timeline-history.ts';
import type {TimelineHistoryState} from '../timeline-history.ts';

export interface SequencePreviewResponse {
  readonly envelope: SequenceEditEnvelope;
  readonly planDigest: string;
  readonly warnings: readonly {readonly code: string}[];
}
export interface SequenceFailure {readonly ok: false; readonly code: string; readonly ids?: readonly string[]; readonly reason?: string}
/** A commit whose result was lost and whose receipt could not settle it. The
 * exact envelope stays in the lost-response state until retry or abandon. */
export interface SequenceUnconfirmed {readonly ok: false; readonly code: typeof UNCONFIRMED_CODE; readonly unconfirmed: true}
export interface SequenceSuccess {readonly ok: true; readonly actionId: string | null; readonly operation: string;
  readonly patch: unknown; readonly receipt?: SequenceEditReceipt;
  /** Settled by the receipt read, not by the lost commit response. */
  readonly resolvedFromReceipt?: true}
export type SequenceOutcome = SequenceSuccess | SequenceFailure | SequenceUnconfirmed;
export interface HistoryActionView {readonly actionId: string; readonly operation: string; readonly affected: number;
  /** Present only for Mio actions (D5); UI Ctrl+Z must not undo these. */
  readonly origin?: 'user' | 'mio'}
export interface SequenceHistoryView {
  readonly projectId?: string;
  readonly epoch: string; readonly position: number; readonly revision: number;
  readonly undo: HistoryActionView | null; readonly redo: HistoryActionView | null;
  /** Added by the unified history service (format-5 0.3.0). Older callers only
   * read the cursor fields above. */
  readonly earliestPosition?: number | null;
  readonly atEarliest?: boolean;
  readonly undoAvailable?: boolean;
  readonly redoAvailable?: boolean;
  readonly undoConflict?: boolean;
  readonly redoConflict?: boolean;
  readonly undoBlockedBy?: 'user' | 'mio' | null;
  readonly redoBlockedBy?: 'user' | 'mio' | null;
}
export type SequenceRpc = (operation: string, input: unknown) => Promise<unknown>;
/** D5 minimal user-undo protection: a Mio action at the top is not part of the
 * user Ctrl+Z stack. Covers both a Mio action above a user action (`undoBlockedBy: 'mio'`)
 * and a Mio-only stack (`position > 0 && atEarliest === false && undo === null`). */
export const format5UserUndoBlocked = (view: SequenceHistoryView | null): boolean =>
  Boolean(view && (
    view.undo?.origin === 'mio'
    || view.undoBlockedBy === 'mio'
    || (view.position > 0 && view.atEarliest === false && view.undo === null)
  ));

export interface Format5TimelineHistoryOptions {
  readonly projectId: string | null | undefined;
  readonly history: SequenceHistoryView | null | undefined;
  readonly busy?: boolean;
  readonly dirty?: boolean;
  readonly online?: boolean;
}

/** Format-5 unified history state shared by the timeline toolbar, keyboard
 * shortcuts (editing and board), and the native Edit menu. Format 3/4 stay on
 * `timelineHistoryState`. */
export function format5TimelineHistoryState({
  projectId,
  history,
  busy = false,
  dirty = false,
  online = true,
}: Format5TimelineHistoryOptions): TimelineHistoryState {
  const synced = Boolean(
    projectId
    && history
    && Number.isSafeInteger(history.position)
    && history.position >= 0
    && (!history.projectId || history.projectId === projectId),
  );
  const blockedMessage = busy ? message('timeline.history.busy')
    : dirty ? message('timeline.history.dirty')
    : !online ? message('timeline.history.offline')
    : !synced ? message('timeline.history.syncing')
    : null;
  const blockedReason = renderMessage('zh-Hans', blockedMessage);
  const mioUndoBlocked = synced && format5UserUndoBlocked(history ?? null);
  const undoReady = Boolean(
    synced
    && (mioUndoBlocked || (Boolean(history?.undo) && history?.undoConflict !== true && history?.atEarliest !== true)),
  );
  const redoReady = Boolean(synced && history?.redo && history?.redoConflict !== true);
  const undoMessage = synced && undoReady
    ? (mioUndoBlocked ? message('editUi.error.mioUndoBlocked') : timelineHistoryOperationMessage(history?.undo?.operation))
    : null;
  const redoMessage = synced && redoReady
    ? timelineHistoryOperationMessage(history?.redo?.operation)
    : null;
  const cursor = synced ? history!.position : null;
  const length = synced ? history!.position + (history!.redo ? 1 : 0) : null;
  return {
    synced,
    cursor,
    length,
    canUndo: Boolean(synced && !blockedMessage && undoReady),
    canRedo: Boolean(synced && !blockedMessage && redoReady),
    undoLabel: renderMessage('zh-Hans', undoMessage),
    redoLabel: renderMessage('zh-Hans', redoMessage),
    blockedReason,
    blockedMessage,
    undoMessage,
    redoMessage,
  };
}

export function format5HistoryScope(view: SequenceHistoryView | null | undefined): string {
  if (!view) return 'none';
  return JSON.stringify([
    view.epoch,
    view.position,
    view.revision,
    view.undo?.actionId ?? null,
    view.redo?.actionId ?? null,
    view.undoConflict === true,
    view.redoConflict === true,
    view.undoBlockedBy ?? null,
    view.redoBlockedBy ?? null,
    view.atEarliest === true,
  ]);
}

const uuid = (): string => globalThis.crypto?.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const value = Math.floor(Math.random() * 16);
    return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
export const format5RequestId = (prefix = 'ui'): string => `${prefix}-${uuid()}`;

export function format5VersionCommand(clipId: string, choice: {readonly mode: 'follow' | 'locked'; readonly versionId: string | null}): SequenceSyncCommand {
  return {kind: 'clip-version', clipId, versionId: choice.versionId, mode: choice.mode};
}
export function format5RemoveCommand(clipId: string): SequenceSyncCommand {
  return {kind: 'clip-remove', clipId};
}
export function format5SplitCommand(clipId: string, offsetFrames: number): SequenceSyncCommand {
  return {kind: 'clip-split', clipId, offsetFrames, rightClipId: uuid()};
}
export function format5TrimCommand(clipId: string, durationFrames: number, sourceInFrame?: number): SequenceSyncCommand {
  return {kind: 'clip-trim', clipId, durationFrames, ...(sourceInFrame === undefined ? {} : {sourceInFrame})};
}
export function format5MoveCommand(clipId: string, beforeClipId: string | null, copyNodeId?: string): SequenceSyncCommand {
  return {kind: 'clip-move', clipId, beforeClipId, ...(copyNodeId ? {copyNodeId} : {})};
}
export function format5MoveOffTrackCommand(clipId: string, trackId: string, startFrame: number, copyNodeId?: string): SequenceSyncCommand {
  return {kind: 'clip-move-off-track', clipId, trackId, startFrame, ...(copyNodeId ? {copyNodeId} : {})};
}
/** ED: put one library asset on a track. `trackId: null` means the main track;
 * the server allocates the board node/clip identities and expands the envelope. */
export function format5InsertAssetCommand(assetId: string, trackId: string | null, startFrame: number): SequenceSyncCommand {
  return {kind: 'insert-asset', assetId, trackId, startFrame};
}
/** ED: paste the copied clip at the playhead; the server allocates every new id. */
export function format5PasteClipCommand(clipId: string, startFrame: number): SequenceSyncCommand {
  return {kind: 'paste-clip', clipId, startFrame};
}
/** The keyboard paste handler is registered once; take the playhead from the
 * live view rather than its render closure. A live playback frame wins when the
 * clock is running, otherwise the current editing playhead does. */
export function format5PasteStartFrame(playbackFrame: number | null | undefined,
  editingPlayhead: number | undefined, fallback: number): number {
  const candidate = [playbackFrame, editingPlayhead, fallback]
    .find(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) ?? 0;
  return Math.max(0, Math.round(candidate));
}

/** Exact clip patch -> one TS command. Only the fields UI-E2 owns are mapped;
 * anything else is reported as unsupported instead of silently writing it. */
export function format5PatchCommand(clip: Pick<AppTimelineClip, 'id' | 'trackId' | 'startFrame' | 'durationFrames' | 'sourceInFrame'>,
  patch: Record<string, unknown>, mainTrackId: string | null): SequenceSyncCommand | {readonly unsupported: readonly string[]} {
  const supported = new Set(['trackId', 'startFrame', 'durationFrames', 'sourceInFrame', 'versionId', 'locked']);
  const unsupported = Object.keys(patch).filter(key => !supported.has(key));
  if (unsupported.length) return {unsupported};
  if (Object.hasOwn(patch, 'versionId') || Object.hasOwn(patch, 'locked')) {
    return {kind: 'clip-version', clipId: clip.id, versionId: (patch.versionId as string | null | undefined) ?? null,
      mode: patch.locked === true ? 'locked' : 'follow'};
  }
  if (Object.hasOwn(patch, 'durationFrames') || Object.hasOwn(patch, 'sourceInFrame')) {
    return format5TrimCommand(clip.id, typeof patch.durationFrames === 'number' ? patch.durationFrames : clip.durationFrames,
      typeof patch.sourceInFrame === 'number' ? patch.sourceInFrame : undefined);
  }
  if (Object.hasOwn(patch, 'trackId') || Object.hasOwn(patch, 'startFrame')) {
    const trackId = typeof patch.trackId === 'string' ? patch.trackId : clip.trackId;
    if (trackId !== mainTrackId) return format5MoveOffTrackCommand(clip.id, trackId,
      typeof patch.startFrame === 'number' ? patch.startFrame : clip.startFrame);
    // Moving within the main track is a reorder; resolve the insertion point
    // from the target start by the caller (who has the sibling order).
    return {unsupported: ['startFrame']};
  }
  return {unsupported: ['patch']};
}

/** User-facing reasons carried by format-5 preview failures. Unknown reasons
 * fall through to the operation-level message rather than inventing a cause. */
const referenceReasonKeys: Readonly<Record<string, string>> = {
  PREVIS_OUTPUT_REQUIRED: 'boardUi.error.referencePrevisOutput',
  ASSET_NOT_READY: 'boardUi.error.referenceAssetNotReady',
  ASSET_UNVERIFIED: 'boardUi.error.referenceAssetUnverified',
  PREVIS_OUTPUT_UNVERIFIED: 'boardUi.error.referenceAssetUnverified',
  ASSET_TYPE_MISMATCH: 'boardUi.error.referenceRoleNotAllowed',
  ROLE_NOT_ALLOWED: 'boardUi.error.referenceRoleNotAllowed',
  NODE_MISSING: 'boardUi.error.referenceMissing',
  SHOT_MISSING: 'boardUi.error.referenceMissing',
  EDGE_MISSING: 'boardUi.error.referenceMissing',
  TIMELINE_ROOT_MISSING: 'boardUi.error.referenceMissing',
  NODE_ARCHIVED: 'boardUi.error.referenceArchived',
  SHOT_ARCHIVED: 'boardUi.error.referenceArchived',
  EDGE_ARCHIVED: 'boardUi.error.referenceArchived',
  NODE_INVALID: 'boardUi.error.referenceInvalid',
  SHOT_INVALID: 'boardUi.error.referenceInvalid',
  EDGE_INVALID: 'boardUi.error.referenceInvalid',
  PREVIS_INVALID: 'boardUi.error.referenceInvalid',
  REFERENCE_INVALID: 'boardUi.error.referenceInvalid',
  EDGE_ID_CONFLICT: 'boardUi.error.referenceInvalid',
  EDGE_ALLOCATION_REQUIRED: 'boardUi.error.referenceInvalid',
  EDGE_TARGET_MISMATCH: 'boardUi.error.referenceTargetMismatch',
  SOURCE_TYPE_INVALID: 'boardUi.error.referenceSourceType',
  SUBJECT_BINDING_REQUIRED: 'boardUi.error.referenceSubjectBinding',
  LAST_FRAME_REQUIRES_FIRST: 'boardUi.error.referenceLastFrameFirst',
  FIRST_FRAME_BLOCKED_BY_LAST: 'boardUi.error.referenceFirstFrameBlocked',
  LAST_FRAME_DETACH_FIRST: 'boardUi.error.referenceLastFrameDetach',
  ORDER_SET_MISMATCH: 'boardUi.error.referenceOrderChanged',
  SUBJECT_MISSING: 'boardUi.error.referenceSubjectMissing',
  SUBJECT_VERSION_MISSING: 'boardUi.error.referenceSubjectMissing',
};
const boardCodeKeys: Readonly<Record<string, string>> = {
  SEQUENCE_EDIT_REFERENCE_INVALID: 'boardUi.error.referenceFailed',
  SEQUENCE_EDIT_SUBJECT_BINDING_INVALID: 'boardUi.error.subjectBindingFailed',
  FORMAT5_CAPACITY: 'boardUi.error.capacity',
  NODE_ALREADY_LINKED: 'boardUi.error.sequenceAlreadyLinked',
  MULTIPLE_PREDECESSORS: 'boardUi.error.sequenceMultiplePredecessors',
  MULTIPLE_SUCCESSORS: 'boardUi.error.sequenceMultipleSuccessors',
  INVALID_SEQUENCE_TYPES: 'boardUi.error.sequenceInvalidTypes',
  TEXT_IS_ANNOTATION: 'boardUi.error.sequenceTextAnnotation',
  CYCLE: 'boardUi.error.sequenceCycle',
};
export function format5BoardFailureMessageKey(code: string | undefined, reason?: string): string {
  if (reason && referenceReasonKeys[reason]) return referenceReasonKeys[reason]!;
  if (code && boardCodeKeys[code]) return boardCodeKeys[code]!;
  return format5CommandErrorMessageKey(code, reason);
}

export function format5CommandErrorMessageKey(code: string | undefined, reason?: string): string {
  const messageKey = sequenceEditFailureMessageKey(code, reason);
  if (messageKey) return messageKey;
  switch (code) {
    case UNCONFIRMED_CODE: return 'editUi.error.EDIT_RESULT_UNCONFIRMED';
    case 'SEQUENCE_EDIT_REVISION_CONFLICT': return 'editUi.error.SEQUENCE_EDIT_REVISION_CONFLICT';
    case 'SEQUENCE_EDIT_HISTORY_CONFLICT': return 'editUi.error.SEQUENCE_EDIT_HISTORY_CONFLICT';
    case 'SEQUENCE_EDIT_PATCH_INVALID': return 'editUi.error.SEQUENCE_EDIT_PATCH_INVALID';
    case 'SEQUENCE_EDIT_TRACK_INVALID': return 'editUi.error.SEQUENCE_EDIT_TRACK_INVALID';
    case 'SEQUENCE_EDIT_CONTRACT_INVALID': return 'editUi.error.SEQUENCE_EDIT_CONTRACT_INVALID';
    case 'SEQUENCE_EDIT_SOUND_INVALID': return 'editUi.error.SEQUENCE_EDIT_SOUND_INVALID';
    case 'FORMAT5_CAPACITY': return 'editUi.error.SEQUENCE_EDIT_SOUND_INVALID';
    // FR-B2 scene split refusals keep the format 3/4 reasons instead of the
    // generic failure: no usable cut, or the shown result is no longer usable.
    case 'NOTHING_TO_SPLIT': return 'scene.split.nothing';
    case 'SEQUENCE_EDIT_SCENE_RESULT_CONFLICT': return 'scene.error.resultConflict';
    case 'SEQUENCE_EDIT_SCENE_RESULT_STALE': return 'scene.error.resultStale';
    default: return 'editUi.error.GENERIC';
  }
}

/** The one-line result of a scene split for the format-5 undo bar: how many
 * clips were split, and how many were skipped because their source range had
 * no usable cut (or only cuts inside a fade). Format 3/4 shows the same two
 * messages as toasts. */
export function format5SceneSplitNotice(sceneSplit: SequenceEditReceipt['sceneSplit']):
  {key: 'scene.split.done' | 'scene.split.doneSkipped'; params: {count: number; skipped: number}} {
  const count = sceneSplit?.split.length ?? 0, skipped = sceneSplit?.skipped.length ?? 0;
  return {key: skipped ? 'scene.split.doneSkipped' : 'scene.split.done', params: {count, skipped}};
}

function versionOf(versions: readonly AppVersion[], id: string | null | undefined): EditUiVersion | null {
  const found = id ? versions.find(version => version.id === id) : undefined;
  return found ? {id: found.id, number: found.number} : null;
}
/** Persisted format-5 projection -> UI-E1 presentation input. The read shape is
 * the one `project.get` already returns; this never invents fields. */
export function format5EditUiTimeline(timeline: AppTimeline | null, shots: readonly AppShot[], versions: readonly AppVersion[]): EditUiTimeline | null {
  if (!timeline) return null;
  const anyTimeline = timeline as unknown as Record<string, any>;
  const mainTrack = anyTimeline.mainTrack && typeof anyTimeline.mainTrack === 'object'
    ? {trackId: String(anyTimeline.mainTrack.trackId), sequenceNodeId: String(anyTimeline.mainTrack.sequenceNodeId)} : null;
  const clips = (timeline.clips ?? []).map(clip => {
    const raw = clip as unknown as Record<string, any>;
    const source = raw.sequenceSource && typeof raw.sequenceSource === 'object' ? raw.sequenceSource : undefined;
    const sequenceSource = source?.kind === 'shot'
      ? (() => {
          const shot = shots.find(item => item.id === String(source.nodeId));
          const shotIndex = shots.findIndex(item => item.id === String(source.nodeId));
          const mode = source.versionMode === 'locked' ? 'locked' as const : 'follow' as const;
          return {kind: 'shot' as const, nodeId: String(source.nodeId), segmentGroupId: String(source.segmentGroupId),
            number: String(shotIndex < 0 ? '' : shotIndex + 1).padStart(2, '0'), name: shot?.title ?? '',
            versionMode: mode, boardVersion: versionOf(versions, shot?.selectedVersionId as string | null | undefined),
            appliedVersion: versionOf(versions, clip.versionId as string | undefined)};
        })()
      : source?.kind === 'media' ? {kind: 'media' as const, nodeId: String(source.nodeId),
          segmentGroupId: String(source.segmentGroupId)} : undefined;
    return {id: clip.id, trackId: clip.trackId, startFrame: clip.startFrame, durationFrames: clip.durationFrames,
      sourceInFrame: clip.sourceInFrame, sourceState: raw.sourceState === 'placeholder' ? 'placeholder' as const : raw.sourceState === 'ready' ? 'ready' as const : undefined,
      ...(sequenceSource ? {sequenceSource} : {}),
      ...(raw.anchor ? {anchor: raw.anchor} : {})};
  });
  const cues = (timeline.subtitles?.cues ?? []).map(cue => ({id: cue.id, startFrame: cue.startFrame,
    ...(Object.hasOwn(cue, 'anchor') ? {anchor: (cue as {anchor?: {clipId: string; offsetFrames: number} | null}).anchor ?? null} : {})}));
  return {fps: timeline.fps || 30, timelineRevision: timeline.revision, syncRevision: Number(anyTimeline.syncRevision ?? 0),
    mainTrack, tracks: (timeline.tracks ?? []).map(track => ({id: track.id, kind: track.kind})), clips, cues};
}
export function format5Projection(timeline: AppTimeline | null, shots: readonly AppShot[], versions: readonly AppVersion[]): EditUiProjection | null {
  const input = format5EditUiTimeline(timeline, shots, versions);
  return input ? projectEditUi(input) : null;
}
export function format5InspectorSequence(timeline: AppTimeline | null, shots: readonly AppShot[], versions: readonly AppVersion[],
  clipId: string, callbacks: Pick<EditUiInspectorSequence, 'onRevealShot' | 'onVersionChoice'>): EditUiInspectorSequence | null {
  const input = format5EditUiTimeline(timeline, shots, versions);
  const clip = input?.clips.find(item => item.id === clipId);
  if (!input || !clip || clip.sequenceSource?.kind !== 'shot') return null;
  const source = clip.sequenceSource;
  return {mainTrackId: input.mainTrack?.trackId ?? null, shotNumber: source.number, shotName: source.name,
    versionMode: source.versionMode, boardVersion: source.boardVersion, appliedVersion: source.appliedVersion,
    ...callbacks};
}

type ParsedCommit = ReturnType<typeof parseSequenceCommit>;
const parsedOutcome = (parsed: ParsedCommit): SequenceOutcome => parsed.kind === 'success'
  ? {ok: true, actionId: parsed.actionId, operation: parsed.operation, patch: parsed.patch, ...(parsed.receipt ? {receipt: parsed.receipt} : {})}
  : parsed.kind === 'failure' ? {ok: false, code: parsed.code, ids: parsed.ids, ...(parsed.reason ? {reason: parsed.reason} : {})}
  : {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};

type PendingEdit = {readonly envelope: SequenceEditEnvelope; readonly planDigest: string};

export interface Format5SessionOptions {
  /** Shared workspace state; both format-5 sessions must receive the same one. */
  readonly lost?: LostResponseState;
  /** Convenience for tests/standalone fixtures; equivalent to a private state. */
  readonly readOutcome?: LostResponseOptions['readOutcome'];
}

/** One preview/confirm session. `preview` may run twice for a copy decision; the
 * second envelope is the one the confirmation and commit must reuse. */
export class Format5EditSession {
  private pending: PendingEdit | null = null;
  private copy: {request: EditUiCopyMoveRequest; pending: PendingEdit} | null = null;
  private inFlight = false;
  private readonly rpc: SequenceRpc;
  private readonly projectId: () => string | null;
  private readonly lost: LostResponseState;
  constructor(rpc: SequenceRpc, projectId: () => string | null, options: Format5SessionOptions = {}) {
    if (options.lost && options.readOutcome) throw new TypeError('Pass either lost or readOutcome, not both.');
    this.rpc = rpc;
    this.projectId = projectId;
    this.lost = options.lost ?? new LostResponseState(options.readOutcome ? {readOutcome: options.readOutcome} : {});
  }

  get busy(): boolean {return this.inFlight}
  get copyRequest(): EditUiCopyMoveRequest | null {return this.copy?.request ?? null}
  /** The one lost edit the App renders a bar for, if any. */
  get unconfirmed(): LostResponseView | null {return this.lost.view}

  /** Before a lost edit is settled, every new format-5 write is refused with one
   * reason; the controls stay enabled on purpose. A retained edit of another
   * project can never be retried here, so switching projects drops it. */
  private guardUnconfirmed(): SequenceFailure | null {
    const view = this.lost.view;
    if (!view) return null;
    if (view.projectId !== this.projectId()) {this.lost.clear(); return null;}
    return {ok: false, code: UNCONFIRMED_CODE};
  }

  private endpoint(operation: string): (input: unknown) => Promise<unknown> {return input => this.rpc(operation, input)}

  async preview(command: SequenceSyncCommand): Promise<SequencePreviewResponse | SequenceFailure> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    const projectId = this.projectId();
    if (!projectId) return {ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID'};
    const requestId = format5RequestId('preview');
    try {
      const response = await this.endpoint('sequence.preview')({projectId, requestId,
        intents: [sequenceSyncIntent(command)]}) as SequencePreviewResponse | SequenceFailure;
      if ((response as SequenceFailure).ok === false) return response as SequenceFailure;
      const preview = response as SequencePreviewResponse;
      if (typeof preview.planDigest !== 'string' || !preview.envelope) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
      this.pending = {envelope: preview.envelope, planDigest: preview.planDigest};
      return preview;
    } catch (error) {
      const ids = extractSequenceErrorIds(error);
      const reason = extractSequenceErrorReason(error);
      return {ok: false, code: (error as {code?: string}).code ?? 'GENERIC', ...(ids ? {ids} : {}), ...(reason ? {reason} : {})};
    }
  }

  /** The one commit path of both sessions' semantics: a definite rejection keeps
   * the old error display, an unknown result retains the exact envelope. */
  private async commitPending(pending: PendingEdit): Promise<SequenceOutcome> {
    const projectId = this.projectId();
    if (!projectId) return {ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID'};
    let row: unknown;
    try {
      row = await this.endpoint('sequence.commit')({projectId, envelope: pending.envelope,
        expectedPlanDigest: pending.planDigest});
    } catch (error) {
      const failure = classifyCommitFailure(error);
      if (failure.kind === 'rejected') {
        this.pending = null; this.copy = null; this.lost.clear();
        return {ok: false, code: failure.code, ids: failure.ids, ...(failure.reason ? {reason: failure.reason} : {})};
      }
      return this.retainUnconfirmed(pending);
    }
    const parsed = parseSequenceCommit(row);
    if (parsed.kind === 'unknown') return this.retainUnconfirmed(pending);
    this.pending = null; this.copy = null; this.lost.clear();
    return parsedOutcome(parsed);
  }
  /** Keep the accepted envelope + digest, read the immutable receipt exactly
   * once, and return the honest conclusion (or stay unconfirmed). */
  private async retainUnconfirmed(pending: PendingEdit): Promise<SequenceOutcome> {
    this.pending = null;
    this.copy = null;
    const entry = {projectId: pending.envelope.projectId, requestId: pending.envelope.requestId,
      envelope: pending.envelope, planDigest: pending.planDigest};
    this.lost.retain(entry, () => this.retryUnconfirmed());
    const verdict = await this.lost.reconcileOnce(() => this.projectId() === entry.projectId);
    if (verdict.kind === 'applied') {
      return {ok: true, actionId: null, operation: verdict.operation ?? 'sequence.edit', patch: undefined,
        resolvedFromReceipt: true};
    }
    if (verdict.kind === 'not_applied') return {ok: false, code: verdict.code};
    return {ok: false, code: UNCONFIRMED_CODE, unconfirmed: true};
  }

  /** The bar's retry: resend the retained envelope/digest, never a new preview. */
  async retryUnconfirmed(): Promise<LostRetryResult> {
    const entry = this.lost.retained;
    if (!entry || this.inFlight || this.projectId() !== entry.projectId) {
      return {ok: false, code: UNCONFIRMED_CODE, unconfirmed: true};
    }

    this.inFlight = true;
    try {
      const result = await this.commitPending({envelope: entry.envelope, planDigest: entry.planDigest});
      if (result.ok) return {ok: true, actionId: result.actionId};
      return 'unconfirmed' in result ? {ok: false, code: result.code, unconfirmed: true} : {ok: false, code: result.code, ...(result.reason ? {reason: result.reason} : {})};
    } finally {this.inFlight = false;}
  }

  /** The bar's abandon: drop the retained envelope without writing or refreshing. */
  abandonUnconfirmed(): void {this.lost.clear()}

  /** FR-B2 output-frame change through the same preview/commit handshake. */
  async format(presetId: string): Promise<SequenceOutcome> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    if (this.inFlight) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
    this.inFlight = true;
    try {
      const projectId = this.projectId();
      if (!projectId) return {ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID'};
      let preview: SequencePreviewResponse | SequenceFailure;
      try {
        preview = await this.endpoint('sequence.preview')({projectId, requestId: format5RequestId('format'),
          formatIntent: {side: 'timeline', operation: {kind: 'timeline-format', presetId}}}) as SequencePreviewResponse | SequenceFailure;
      } catch (error) {
        const ids = extractSequenceErrorIds(error);
        return {ok: false, code: (error as {code?: string}).code ?? 'GENERIC', ...(ids ? {ids} : {})};
      }
      if ((preview as SequenceFailure).ok === false) return preview as SequenceFailure;
      const response = preview as SequencePreviewResponse;
      if (!response.envelope || typeof response.planDigest !== 'string') return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
      const pending = {envelope: response.envelope, planDigest: response.planDigest};
      this.pending = pending;
      return await this.commitPending(pending);
    } finally {this.inFlight = false;}
  }
  /** FR-B2: split one main-track clip at the current scene cuts. */
  async splitAtScenes(assetId: string, resultId: string): Promise<SequenceOutcome> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    if (this.inFlight) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
    this.inFlight = true;
    try {
      const projectId = this.projectId();
      if (!projectId) return {ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID'};
      let preview: SequencePreviewResponse | SequenceFailure;
      try {
        preview = await this.endpoint('sequence.preview')({projectId, requestId: format5RequestId('split-scenes'),
          intents: [sequenceSyncIntent({kind: 'clip-split-scenes', assetId, resultId})]}) as SequencePreviewResponse | SequenceFailure;
      } catch (error) {
        const ids = extractSequenceErrorIds(error);
        return {ok: false, code: (error as {code?: string}).code ?? 'GENERIC', ...(ids ? {ids} : {})};
      }
      if ((preview as SequenceFailure).ok === false) return preview as SequenceFailure;
      const response = preview as SequencePreviewResponse;
      if (!response.envelope || typeof response.planDigest !== 'string') return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
      const pending = {envelope: response.envelope, planDigest: response.planDigest};
      this.pending = pending;
      return await this.commitPending(pending);
    } finally {this.inFlight = false;}
  }

  /** UI-E3: one FR-A properties / FR-B subtitles action through the same
   * preview + lost-response commit handshake as every other format-5 write. */
  async runPayload(payload: Readonly<Record<string, unknown>>): Promise<SequenceOutcome> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    if (this.inFlight) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
    this.inFlight = true;
    try {
      const projectId = this.projectId();
      if (!projectId) return {ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID'};
      let preview: SequencePreviewResponse | SequenceFailure;
      try {
        preview = await this.endpoint('sequence.preview')({projectId, requestId: format5RequestId('panel-preview'),
          ...payload}) as SequencePreviewResponse | SequenceFailure;
      } catch (error) {
        const ids = extractSequenceErrorIds(error);
        return {ok: false, code: (error as {code?: string}).code ?? 'GENERIC', ...(ids ? {ids} : {})};
      }
      if ((preview as SequenceFailure).ok === false) return preview as SequenceFailure;
      const response = preview as SequencePreviewResponse;
      if (!response.envelope || typeof response.planDigest !== 'string') return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
      const pending = {envelope: response.envelope, planDigest: response.planDigest};
      this.pending = pending;
      return await this.commitPending(pending);
    } finally {this.inFlight = false;}
  }

  async commit(): Promise<SequenceOutcome> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    if (this.inFlight) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
    const pending = this.pending;
    if (!pending) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
    this.inFlight = true;
    try {return await this.commitPending(pending);} finally {this.inFlight = false;}
  }
  /** Preview then commit; one click while a request is in flight never queues a
   * second write. */
  /** FR-D: one track add/update through the same preview/commit handshake. */
  async runTrack(trackIntent: SequenceEditTrackIntent): Promise<SequenceOutcome> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    if (this.inFlight) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
    this.inFlight = true;
    try {
      const projectId = this.projectId();
      if (!projectId) return {ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID'};
      let preview: SequencePreviewResponse | SequenceFailure;
      try {
        preview = await this.endpoint('sequence.preview')({projectId, requestId: format5RequestId('track-preview'),
          trackIntent}) as SequencePreviewResponse | SequenceFailure;
      } catch (error) {
        const ids = extractSequenceErrorIds(error);
        return {ok: false, code: (error as {code?: string}).code ?? 'GENERIC', ...(ids ? {ids} : {})};
      }
      if ((preview as SequenceFailure).ok === false) return preview as SequenceFailure;
      const pending = {envelope: (preview as SequencePreviewResponse).envelope,
        planDigest: (preview as SequencePreviewResponse).planDigest};
      this.pending = pending;
      return await this.commitPending(pending);
    } finally {this.inFlight = false;}
  }
  async run(command: SequenceSyncCommand): Promise<SequenceOutcome> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    if (this.inFlight) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
    this.inFlight = true;
    try {
      const preview = await this.preview(command);
      if ((preview as SequenceFailure).ok === false) return preview as SequenceFailure;
      return await this.commitPending(this.pending!);
    } finally {this.inFlight = false;}
  }
  /** Reorder/copy-aware move: try the plain move first, then re-preview with the
   * server-allocated copy identity. The confirmation shows only after the copy
   * preview succeeds; confirm commits that exact envelope and digest. */
  async requestMove(command: SequenceSyncCommand, request: Omit<EditUiCopyMoveRequest, 'timelineRevision'> & {timelineRevision: number}): Promise<SequenceOutcome | {readonly needsCopy: true}> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    if (this.inFlight) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
    this.inFlight = true;
    try {
      const firstPreview = await this.preview(command);
      if ((firstPreview as SequenceFailure).ok === false) {
        if ((firstPreview as SequenceFailure).code !== 'COPY_NODE_REQUIRED') return firstPreview as SequenceFailure;
        const copyNodeId = uuid();
        const copyPreview = await this.preview({...command, copyNodeId} as SequenceSyncCommand);
        if ((copyPreview as SequenceFailure).ok === false) return copyPreview as SequenceFailure;
        this.copy = {request, pending: this.pending!};
        return {needsCopy: true};
      }
      return await this.commitPending(this.pending!);
    } finally {this.inFlight = false;}
  }
  async confirmCopy(): Promise<SequenceOutcome> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    if (!this.copy) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
    const pending = this.copy.pending;
    this.pending = pending;
    this.copy = null;
    this.inFlight = true;
    try {return await this.commitPending(pending);} finally {this.inFlight = false;}
  }
  cancelCopy(): void {this.copy = null; this.pending = null;}

  async history(): Promise<SequenceHistoryView | null> {
    const projectId = this.projectId();
    if (!projectId) return null;
    try {return await this.endpoint('sequence.history.get')({projectId, origin: 'user'}) as SequenceHistoryView;}
    catch {return null;}
  }
  async undo(view: SequenceHistoryView): Promise<SequenceOutcome> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    const projectId = this.projectId();
    if (!projectId || !view.undo || view.undoConflict === true) return {ok: false, code: 'SEQUENCE_EDIT_HISTORY_CONFLICT'};
    try {
      return parsedOutcome(parseSequenceCommit(await this.endpoint('sequence.undo')({projectId, requestId: format5RequestId('undo'),
        origin: 'user', actionId: view.undo.actionId, expected: {position: view.position, revision: view.revision}})));
    } catch (error) {
      const ids = extractSequenceErrorIds(error);
      return {ok: false, code: (error as {code?: string}).code ?? 'GENERIC', ...(ids ? {ids} : {})};
    }
  }
  async redo(view: SequenceHistoryView): Promise<SequenceOutcome> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    const projectId = this.projectId();
    if (!projectId || !view.redo || view.redoConflict === true) return {ok: false, code: 'SEQUENCE_EDIT_HISTORY_CONFLICT'};
    try {
      return parsedOutcome(parseSequenceCommit(await this.endpoint('sequence.redo')({projectId, requestId: format5RequestId('redo'),
        origin: 'user', actionId: view.redo.actionId, expected: {position: view.position, revision: view.revision}})));
    } catch (error) {
      const ids = extractSequenceErrorIds(error);
      return {ok: false, code: (error as {code?: string}).code ?? 'GENERIC', ...(ids ? {ids} : {})};
    }
  }
}
