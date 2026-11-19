/** UI-B2 preview -> commit handshake over the single format-5 sequence RPC.
 *
 * The session only carries identities and the returned envelope/digest; the
 * project service builds the baseline, impact and any new clip/edge allocation.
 * One in-flight command per session prevents double clicks from writing twice.
 */
import type {SequenceEditEnvelope, SequenceEditIntent, SequenceEditReceipt} from '../../../../packages/contracts/src/sequence-edit.ts';
import {format5RequestId} from '../edit-ui/session.ts';
import type {SequenceHistoryView} from '../edit-ui/session.ts';

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
export interface BoardMountView {
  readonly projectId: string;
  readonly timelineRevision: number;
  readonly syncRevision: number;
  readonly inSync: boolean;
  readonly archived: readonly BoardArchivedRow[];
}
export interface BoardSuccess {readonly ok: true; readonly actionId: string; readonly operation: string;
  readonly status: 'applied' | 'not_applied'; readonly receipt: SequenceEditReceipt}
export interface BoardFailure {readonly ok: false; readonly code: string; readonly ids?: readonly string[]}
export type BoardOutcome = BoardSuccess | BoardFailure;

const record = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Row : null;
const codeOf = (error: unknown): string => (error as {code?: unknown})?.code !== undefined
  ? String((error as {code?: unknown}).code) : 'GENERIC';

function receiptOutcome(value: unknown): BoardOutcome {
  const row = record(value);
  if (!row) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
  if (row.ok === false) return {ok: false, code: String(row.code ?? 'SEQUENCE_EDIT_PATCH_INVALID'), ids: row.ids as string[] | undefined};
  const receipt = record(row.receipt) ?? row;
  const status = receipt.status === 'not_applied' ? 'not_applied' as const : 'applied' as const;
  return {ok: true, actionId: String(row.actionId ?? receipt.actionId), operation: String(row.operation ?? receipt.operation),
    status, receipt: receipt as unknown as SequenceEditReceipt};
}

export class BoardUiSession {
  private inFlight = false;
  private readonly rpc: BoardRpc;
  private readonly projectId: () => string | null;
  constructor(rpc: BoardRpc, projectId: () => string | null) {
    this.rpc = rpc;
    this.projectId = projectId;
  }
  get busy(): boolean {return this.inFlight}
  private endpoint(operation: string): (input: unknown) => Promise<unknown> {
    return input => this.rpc(operation, input);
  }
  async run(intent: SequenceEditIntent): Promise<BoardOutcome> {
    if (this.inFlight) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
    this.inFlight = true;
    try {
      const projectId = this.projectId();
      if (!projectId) return {ok: false, code: 'SEQUENCE_EDIT_CONTRACT_INVALID'};
      let preview: Row | null;
      try {
        preview = record(await this.endpoint('sequence.preview')({projectId, requestId: format5RequestId('board-preview'),
          intents: [intent]}));
      } catch (error) {return {ok: false, code: codeOf(error)};}
      if (!preview) return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
      if (preview.ok === false) return {ok: false, code: String(preview.code ?? 'SEQUENCE_EDIT_PATCH_INVALID'),
        ids: preview.ids as string[] | undefined};
      const envelope = record(preview.envelope) as unknown as SequenceEditEnvelope | null;
      if (!envelope || typeof preview.planDigest !== 'string') return {ok: false, code: 'SEQUENCE_EDIT_PATCH_INVALID'};
      try {
        return receiptOutcome(await this.endpoint('sequence.commit')({projectId,
          envelope, expectedPlanDigest: preview.planDigest}));
      } catch (error) {return {ok: false, code: codeOf(error)};}
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
    const projectId = this.projectId();
    if (!projectId || !view.undo || view.undoConflict === true) return {ok: false, code: 'SEQUENCE_EDIT_HISTORY_CONFLICT'};
    try {
      return receiptOutcome(await this.endpoint('sequence.undo')({projectId, requestId: format5RequestId('board-undo'),
        origin: 'user', actionId: view.undo.actionId, expected: {position: view.position, revision: view.revision}}));
    } catch (error) {return {ok: false, code: codeOf(error)};}
  }
  async redo(view: BoardHistoryView): Promise<BoardOutcome> {
    const projectId = this.projectId();
    if (!projectId || !view.redo || view.redoConflict === true) return {ok: false, code: 'SEQUENCE_EDIT_HISTORY_CONFLICT'};
    try {
      return receiptOutcome(await this.endpoint('sequence.redo')({projectId, requestId: format5RequestId('board-redo'),
        origin: 'user', actionId: view.redo.actionId, expected: {position: view.position, revision: view.revision}}));
    } catch (error) {return {ok: false, code: codeOf(error)};}
  }
}
