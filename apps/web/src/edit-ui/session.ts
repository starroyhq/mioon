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
import {classifyCommitFailure, LostResponseState, parseSequenceCommit, UNCONFIRMED_CODE} from './lost-response.ts';
import type {LostResponseOptions, LostResponseView, LostRetryResult} from './lost-response.ts';

export interface SequencePreviewResponse {
  readonly envelope: SequenceEditEnvelope;
  readonly planDigest: string;
  readonly warnings: readonly {readonly code: string}[];
}
export interface SequenceFailure {readonly ok: false; readonly code: string; readonly ids?: readonly string[]}
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
 * user Ctrl+Z stack. MT-4 adds the separate cursor/conflict rules. */
export const format5UserUndoBlocked = (view: SequenceHistoryView | null): boolean =>
  view?.undo?.origin === 'mio' || view?.undoBlockedBy === 'mio';

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

export function format5CommandErrorMessageKey(code: string | undefined): string {
  switch (code) {
    case UNCONFIRMED_CODE: return 'editUi.error.EDIT_RESULT_UNCONFIRMED';
    case 'COPY_NODE_REQUIRED': return 'editUi.error.COPY_NODE_REQUIRED';
    case 'SEQUENCE_EDIT_ANCHOR_CONFLICT': return 'editUi.error.SEQUENCE_EDIT_ANCHOR_CONFLICT';
    case 'SEQUENCE_EDIT_REVISION_CONFLICT': return 'editUi.error.SEQUENCE_EDIT_REVISION_CONFLICT';
    case 'SEQUENCE_EDIT_HISTORY_CONFLICT': return 'editUi.error.SEQUENCE_EDIT_HISTORY_CONFLICT';
    case 'SEQUENCE_EDIT_PATCH_INVALID': return 'editUi.error.SEQUENCE_EDIT_PATCH_INVALID';
    case 'SEQUENCE_EDIT_NOOP': return 'editUi.error.SEQUENCE_EDIT_NOOP';
    case 'SEQUENCE_EDIT_TRACK_INVALID': return 'editUi.error.SEQUENCE_EDIT_TRACK_INVALID';
    case 'SEQUENCE_EDIT_CONTRACT_INVALID': return 'editUi.error.SEQUENCE_EDIT_CONTRACT_INVALID';
    default: return 'editUi.error.GENERIC';
  }
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
  : parsed.kind === 'failure' ? {ok: false, code: parsed.code, ids: parsed.ids}
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
      return {ok: false, code: (error as {code?: string}).code ?? 'GENERIC'};
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
        return {ok: false, code: failure.code, ids: failure.ids};
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
      return 'unconfirmed' in result ? {ok: false, code: result.code, unconfirmed: true} : {ok: false, code: result.code};
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
      } catch (error) {return {ok: false, code: (error as {code?: string}).code ?? 'GENERIC'};}
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
      } catch (error) {return {ok: false, code: (error as {code?: string}).code ?? 'GENERIC'};}
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
      } catch (error) {return {ok: false, code: (error as {code?: string}).code ?? 'GENERIC'};}
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
    } catch (error) {return {ok: false, code: (error as {code?: string}).code ?? 'GENERIC'};}
  }
  async redo(view: SequenceHistoryView): Promise<SequenceOutcome> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    const projectId = this.projectId();
    if (!projectId || !view.redo || view.redoConflict === true) return {ok: false, code: 'SEQUENCE_EDIT_HISTORY_CONFLICT'};
    try {
      return parsedOutcome(parseSequenceCommit(await this.endpoint('sequence.redo')({projectId, requestId: format5RequestId('redo'),
        origin: 'user', actionId: view.redo.actionId, expected: {position: view.position, revision: view.revision}})));
    } catch (error) {return {ok: false, code: (error as {code?: string}).code ?? 'GENERIC'};}
  }
}
