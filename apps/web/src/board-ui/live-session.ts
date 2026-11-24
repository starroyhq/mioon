/** UI-B2 preview -> commit handshake over the single format-5 sequence RPC.
 *
 * The session only carries identities and the returned envelope/digest; the
 * project service builds the baseline, impact and any new clip/edge allocation.
 * One in-flight command per session prevents double clicks from writing twice.
 */
import type {SequenceEditAllocation, SequenceEditEnvelope, SequenceEditGenerateIntent, SequenceEditIntent,
  SequenceEditReceipt, SubjectEditOperation} from '../../../../packages/contracts/src/sequence-edit.ts';
import {format5RequestId} from '../edit-ui/session.ts';
import type {BoardEditRequest} from './inputs.ts';
import {isBoardEditRequest} from './inputs.ts';
import type {SequenceHistoryView} from '../edit-ui/session.ts';
import {classifyCommitFailure, LostResponseState, parseSequenceCommit, UNCONFIRMED_CODE} from '../edit-ui/lost-response.ts';
import type {LostResponseOptions, LostResponseView, LostRetryResult} from '../edit-ui/lost-response.ts';

type Row = Record<string, any>;
export type BoardRpc = (operation: string, input: unknown) => Promise<unknown>;
export interface BoardHistoryView extends SequenceHistoryView {
  readonly projectId?: string;
  readonly earliestPosition?: number | null;
  readonly atEarliest?: boolean;
  readonly undoAvailable?: boolean;
  readonly redoAvailable?: boolean;
  readonly undoConflict?: boolean;
  readonly redoConflict?: boolean;
  readonly undoBlockedBy?: 'user' | 'mio' | null;
  readonly redoBlockedBy?: 'user' | 'mio' | null;
}
export interface BoardArchivedRow {readonly id: string; readonly kind: 'shot' | 'node'; readonly name: string;
  readonly position: {readonly x: number; readonly y: number} | null}
export interface BoardSubjectVersion {readonly id: string; readonly number: number; readonly assetId: string}
export interface BoardSubject {
  readonly id: string; readonly name: string; readonly kind: 'character' | 'product' | 'location' | 'look';
  readonly headVersionId: string; readonly headNumber: number; readonly headAssetId: string;
  readonly versions: readonly BoardSubjectVersion[];
}
export interface BoardBinding {
  readonly id: string; readonly shotId: string; readonly subjectId: string; readonly role: 'subject' | 'style';
  readonly bindingMode: 'follow' | 'locked' | 'detached'; readonly subjectVersionId: string | null;
  readonly edgeId: string | null;
}
export interface BoardMountView {
  readonly projectId: string;
  readonly timelineRevision: number;
  readonly syncRevision: number;
  readonly inSync: boolean;
  readonly archived: readonly BoardArchivedRow[];
  readonly subjects: readonly BoardSubject[];
  readonly bindings: readonly BoardBinding[];
}
export interface BoardSuccess {readonly ok: true; readonly actionId: string | null; readonly operation: string;
  readonly status: 'applied'; readonly receipt?: SequenceEditReceipt;
  /** Settled by the receipt read, not by the lost commit response. */
  readonly resolvedFromReceipt?: true}
export interface BoardFailure {readonly ok: false; readonly code: string; readonly ids?: readonly string[];
  /** Bounded server detail for a specific user-facing reason, never raw data. */
  readonly reason?: string}
/** A board commit whose result was lost and whose receipt could not settle it. */
export interface BoardUnconfirmed {readonly ok: false; readonly code: typeof UNCONFIRMED_CODE; readonly unconfirmed: true}
export type BoardOutcome = BoardSuccess | BoardFailure | BoardUnconfirmed;
export interface BoardSessionOptions {
  /** Shared workspace state; both format-5 sessions must receive the same one. */
  readonly lost?: LostResponseState;
  /** Convenience for tests/standalone fixtures; equivalent to a private state. */
  readonly readOutcome?: LostResponseOptions['readOutcome'];
}

const record = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Row : null;
const codeOf = (error: unknown): string => (error as {code?: unknown})?.code !== undefined
  ? String((error as {code?: unknown}).code) : 'GENERIC';

/** Undo/redo answers: the same three states, with a definite not-applied
 * receipt surfaced as a rejection instead of an applied outcome. */
function receiptOutcome(value: unknown): BoardOutcome {
  const parsed = parseSequenceCommit(value);
  if (parsed.kind === 'failure') return {ok: false, code: parsed.code, ids: parsed.ids};
  if (parsed.kind === 'unknown') return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
  return {ok: true, actionId: parsed.actionId, operation: parsed.operation, status: 'applied',
    ...(parsed.receipt ? {receipt: parsed.receipt} : {})};
}

export class BoardUiSession {
  private inFlight = false;
  private readonly rpc: BoardRpc;
  private readonly projectId: () => string | null;
  private readonly lost: LostResponseState;
  constructor(rpc: BoardRpc, projectId: () => string | null, options: BoardSessionOptions = {}) {
    if (options.lost && options.readOutcome) throw new TypeError('Pass either lost or readOutcome, not both.');
    this.rpc = rpc;
    this.projectId = projectId;
    this.lost = options.lost ?? new LostResponseState(options.readOutcome ? {readOutcome: options.readOutcome} : {});
  }
  get busy(): boolean {return this.inFlight}
  /** The one lost edit the App renders a bar for, if any. */
  get unconfirmed(): LostResponseView | null {return this.lost.view}
  /** Before a lost edit is settled, every new board write is refused with one
   * reason; the controls stay enabled on purpose. */
  private guardUnconfirmed(): BoardFailure | null {
    const view = this.lost.view;
    if (!view) return null;
    if (view.projectId !== this.projectId()) {this.lost.clear(); return null;}
    return {ok: false, code: UNCONFIRMED_CODE};
  }
  private endpoint(operation: string): (input: unknown) => Promise<unknown> {
    return input => this.rpc(operation, input);
  }
  /** The one commit path of every board action family. */
  private async commitEnvelope(projectId: string, envelope: SequenceEditEnvelope,
    planDigest: string): Promise<BoardOutcome> {
    let row: unknown;
    try {
      row = await this.endpoint('sequence.commit')({projectId, envelope, expectedPlanDigest: planDigest});
    } catch (error) {
      const failure = classifyCommitFailure(error);
      if (failure.kind === 'rejected') {this.lost.clear(); return {ok: false, code: failure.code, ids: failure.ids, ...(failure.reason ? {reason: failure.reason} : {})};}
      return this.retainUnconfirmed(envelope, planDigest);
    }
    const parsed = parseSequenceCommit(row);
    if (parsed.kind === 'unknown') return this.retainUnconfirmed(envelope, planDigest);
    this.lost.clear();
    if (parsed.kind === 'failure') return {ok: false, code: parsed.code, ids: parsed.ids};
    return {ok: true, actionId: parsed.actionId, operation: parsed.operation, status: 'applied',
      ...(parsed.receipt ? {receipt: parsed.receipt} : {})};
  }
  /** Keep the accepted envelope + digest, read the immutable receipt exactly
   * once, and return the honest conclusion (or stay unconfirmed). */
  private async retainUnconfirmed(envelope: SequenceEditEnvelope, planDigest: string): Promise<BoardOutcome> {
    const entry = {projectId: envelope.projectId, requestId: envelope.requestId, envelope, planDigest};
    this.lost.retain(entry, () => this.retryUnconfirmed());
    const verdict = await this.lost.reconcileOnce(() => this.projectId() === entry.projectId);
    if (verdict.kind === 'applied') {
      return {ok: true, actionId: null, operation: verdict.operation ?? 'sequence.edit', status: 'applied',
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
      const result = await this.commitEnvelope(entry.projectId, entry.envelope, entry.planDigest);
      if (result.ok) return {ok: true, actionId: result.actionId};
      return 'unconfirmed' in result ? {ok: false, code: result.code, unconfirmed: true} : {ok: false, code: result.code};
    } finally {this.inFlight = false;}
  }
  /** The bar's abandon: drop the retained envelope without writing or refreshing. */
  abandonUnconfirmed(): void {this.lost.clear()}

  /** One user action may carry several board intents (e.g. create structure);
   * the preview/commit envelope keeps them in one history step. */
  async runMany(intents: readonly SequenceEditIntent[]): Promise<BoardOutcome> {
    if (!intents.length) return {ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID'};
    return this.runPayload({intents: [...intents]});
  }
  /** Preview exactly one action family: a CS/TS intent, or an RI reference-line
   * request. Subject binding actions keep their separate `runSubject` path. */
  async run(request: SequenceEditIntent | BoardEditRequest): Promise<BoardOutcome> {
    return this.runPayload(isBoardEditRequest(request) ? request : {intents: [request]});
  }
  private async runPayload(payload: {intents: readonly SequenceEditIntent[]} | BoardEditRequest): Promise<BoardOutcome> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    if (this.inFlight) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
    this.inFlight = true;
    try {
      const projectId = this.projectId();
      if (!projectId) return {ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID'};
      let preview: Row | null;
      try {
        preview = record(await this.endpoint('sequence.preview')({projectId, requestId: format5RequestId('board-preview'),
          ...payload}));
      } catch (error) {return {ok: false, code: codeOf(error)};}
      if (!preview) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
      if (preview.ok === false) return {ok: false, code: String(preview.code ?? 'SEQUENCE_EDIT_PATCH_INVALID'),
        ids: preview.ids as string[] | undefined};
      const envelope = record(preview.envelope) as unknown as SequenceEditEnvelope | null;
      if (!envelope || typeof preview.planDigest !== 'string') return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
      return await this.commitEnvelope(projectId, envelope, preview.planDigest);
    } finally {this.inFlight = false;}
  }
  /** GE-b: place a generation placeholder (or resize one) through the same
   * single preview/commit handshake; the service allocates the shot/clip ids
   * returned in the envelope and the timeline intent is one history step. */
  async runGenerate(generateIntent: SequenceEditGenerateIntent): Promise<BoardOutcome> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    if (this.inFlight) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
    this.inFlight = true;
    try {
      const projectId = this.projectId();
      if (!projectId) return {ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID'};
      let preview: Row | null;
      try {
        preview = record(await this.endpoint('sequence.preview')({projectId, requestId: format5RequestId('generate-preview'),
          generateIntent}));
      } catch (error) {return {ok: false, code: codeOf(error)};}
      if (!preview) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
      if (preview.ok === false) return {ok: false, code: String(preview.code ?? 'SEQUENCE_EDIT_PATCH_INVALID'),
        ids: preview.ids as string[] | undefined};
      const envelope = record(preview.envelope) as unknown as SequenceEditEnvelope | null;
      if (!envelope || typeof preview.planDigest !== 'string') return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
      return await this.commitEnvelope(projectId, envelope, preview.planDigest);
    } finally {this.inFlight = false;}
  }
  async runSubject(operation: SubjectEditOperation, allocation?: SequenceEditAllocation): Promise<BoardOutcome> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    if (this.inFlight) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
    this.inFlight = true;
    try {
      const projectId = this.projectId();
      if (!projectId) return {ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID'};
      let preview: Row | null;
      try {
        preview = record(await this.endpoint('sequence.preview')({projectId, requestId: format5RequestId('subject-preview'),
          subjectIntent: {side: 'board', operation}, ...(allocation ? {allocation} : {})}));
      } catch (error) {return {ok: false, code: codeOf(error)};}
      if (!preview) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
      if (preview.ok === false) return {ok: false, code: String(preview.code ?? 'SEQUENCE_EDIT_PATCH_INVALID'),
        ids: preview.ids as string[] | undefined};
      const envelope = record(preview.envelope) as unknown as SequenceEditEnvelope | null;
      if (!envelope || typeof preview.planDigest !== 'string') return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
      return await this.commitEnvelope(projectId, envelope, preview.planDigest);
    } finally {this.inFlight = false;}
  }
  async history(): Promise<BoardHistoryView | null> {
    const projectId = this.projectId();
    if (!projectId) return null;
    try {return await this.endpoint('sequence.history.get')({projectId, origin: 'user'}) as BoardHistoryView;}
    catch {return null;}
  }
  async board(): Promise<BoardMountView | null> {
    const projectId = this.projectId();
    if (!projectId) return null;
    try {return await this.endpoint('sequence.board.get')({projectId}) as BoardMountView;}
    catch {return null;}
  }
  async undo(view: BoardHistoryView): Promise<BoardOutcome> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    const projectId = this.projectId();
    if (!projectId || !view.undo || view.undoConflict === true) return {ok: false, code: 'SEQUENCE_EDIT_HISTORY_CONFLICT'};
    try {
      return receiptOutcome(await this.endpoint('sequence.undo')({projectId, requestId: format5RequestId('board-undo'),
        origin: 'user', actionId: view.undo.actionId, expected: {position: view.position, revision: view.revision}}));
    } catch (error) {return {ok: false, code: codeOf(error)};}
  }
  async redo(view: BoardHistoryView): Promise<BoardOutcome> {
    const blocked = this.guardUnconfirmed();
    if (blocked) return blocked;
    const projectId = this.projectId();
    if (!projectId || !view.redo || view.redoConflict === true) return {ok: false, code: 'SEQUENCE_EDIT_HISTORY_CONFLICT'};
    try {
      return receiptOutcome(await this.endpoint('sequence.redo')({projectId, requestId: format5RequestId('board-redo'),
        origin: 'user', actionId: view.redo.actionId, expected: {position: view.position, revision: view.revision}}));
    } catch (error) {return {ok: false, code: codeOf(error)};}
  }
}
