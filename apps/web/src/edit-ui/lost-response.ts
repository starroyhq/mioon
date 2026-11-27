/** Shared lost-response state for the two format-5 sessions.
 *
 * `sequence.commit` is a write whose response can get lost. Both sessions keep
 * the exact accepted envelope + plan digest on such an unknown result, block
 * further format-5 edits, read the immutable receipt once (read-only, never a
 * replay) and then either conclude or offer retry/abandon. Retry resends the
 * same envelope/digest, so the server replays its stored receipt instead of
 * writing twice. Format 3/4 has its own pending/re-read path and never uses
 * this module.
 */
import {ApiError} from '../api.ts';
import type {RequestOutcome} from '../request-outcome-client.ts';
import type {SequenceEditEnvelope, SequenceEditReceipt} from '../../../../packages/contracts/src/sequence-edit.ts';

export const UNCONFIRMED_CODE = 'EDIT_RESULT_UNCONFIRMED';
/** One bounded receipt read after an unknown commit; never a poll loop. */
export const LOST_RESPONSE_READ_TIMEOUT_MS = 5000;

export interface RetainedSequenceEdit {
  readonly projectId: string;
  /** Always `envelope.requestId`: the only identity `sequence.commit` reuses. */
  readonly requestId: string;
  readonly envelope: SequenceEditEnvelope;
  readonly planDigest: string;
}

/** What the App needs to render the unconfirmed bar. */
export interface LostResponseView {readonly projectId: string; readonly requestId: string}

export interface SequenceDialogueBlocker {
  readonly cueId: string;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly textExcerpt: string;
}

export interface SequenceDialogueConflict {
  readonly blockers: readonly SequenceDialogueBlocker[];
  readonly blockerCount: number;
  readonly requiredFrames: number;
  readonly availableFrames: number;
}

export type CommitFailure =
  | {readonly kind: 'rejected'; readonly code: string; readonly ids?: readonly string[]; readonly reason?: string;
    readonly dialogueConflict?: SequenceDialogueConflict}
  | {readonly kind: 'unknown'};

export type LostVerdict =
  | {readonly kind: 'applied'; readonly operation: string | null}
  | {readonly kind: 'not_applied'; readonly code: string; readonly operation: string | null}
  | {readonly kind: 'unknown'};

export type LostRetryResult =
  | {readonly ok: true; readonly actionId: string | null}
  | {readonly ok: false; readonly code: string; readonly unconfirmed?: true; readonly reason?: string};

export interface LostResponseOptions {
  readonly readOutcome?: (input: {readonly projectId: string; readonly requestId: string},
    options?: {readonly signal?: AbortSignal}) => Promise<RequestOutcome>;
  readonly readTimeoutMs?: number;
  readonly onChange?: (view: LostResponseView | null) => void;
  readonly onNoop?: (projectId: string) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const codeOf = (value: unknown): string | null => isRecord(value) && typeof value.code === 'string' && value.code ? value.code : null;

export function isSequenceEditNoop(value: unknown): boolean {
  return codeOf(value) === 'SEQUENCE_EDIT_NOOP' ||
    (isRecord(value) && isRecord(value.receipt) && value.receipt.status === 'not_applied' && codeOf(value.receipt) === 'SEQUENCE_EDIT_NOOP');
}

/** Refresh a definite no-op without changing the result contract. The same
 * readback handles preview refusals, commit receipts, and receipt recovery. */
export async function refreshOnSequenceEditNoop<T>(request: Promise<T>, refresh: () => Promise<void>): Promise<T> {
  let result: T;
  try { result = await request; }
  catch (error) {
    if (isSequenceEditNoop(error) && classifyCommitFailure(error).kind === 'rejected') await refresh();
    throw error;
  }
  if (isSequenceEditNoop(result)) await refresh();
  return result;
}

export function extractSequenceErrorIds(error: unknown): readonly string[] | undefined {
  if (!isRecord(error)) return undefined;
  const details = isRecord(error.details) ? error.details : undefined;
  const raw = Array.isArray(error.ids) ? error.ids : details && Array.isArray(details.ids) ? details.ids : null;
  if (!raw) return undefined;
  const ids = raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
  return ids.length ? ids : undefined;
}

export function extractSequenceErrorReason(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const details = isRecord(error.details) ? error.details : error;
  return typeof details.reason === 'string' && details.reason ? details.reason : undefined;
}

export function extractSequenceDialogueConflict(error: unknown): SequenceDialogueConflict | undefined {
  if (!isRecord(error)) return undefined;
  const details = isRecord(error.details) ? error.details : undefined;
  const raw = isRecord(error.dialogueConflict) ? error.dialogueConflict
    : details && isRecord(details.dialogueConflict) ? details.dialogueConflict : null;
  if (!raw || !Array.isArray(raw.blockers)) return undefined;
  if (typeof raw.blockerCount !== 'number' || !Number.isInteger(raw.blockerCount) || raw.blockerCount < 0) return undefined;
  if (typeof raw.requiredFrames !== 'number' || !Number.isInteger(raw.requiredFrames) || raw.requiredFrames <= 0) return undefined;
  if (typeof raw.availableFrames !== 'number' || !Number.isInteger(raw.availableFrames) || raw.availableFrames < 0) return undefined;
  const blockers: SequenceDialogueBlocker[] = [];
  for (const item of raw.blockers) {
    if (!isRecord(item) || typeof item.cueId !== 'string' || !item.cueId) continue;
    if (typeof item.startFrame !== 'number' || !Number.isInteger(item.startFrame) || item.startFrame < 0) continue;
    if (typeof item.endFrame !== 'number' || !Number.isInteger(item.endFrame) || item.endFrame < item.startFrame) continue;
    const textExcerpt = typeof item.textExcerpt === 'string' ? item.textExcerpt : '';
    blockers.push({cueId: item.cueId, startFrame: item.startFrame, endFrame: item.endFrame, textExcerpt});
  }
  return {blockers, blockerCount: raw.blockerCount, requiredFrames: raw.requiredFrames, availableFrames: raw.availableFrames};
}

/** Only a definite rejection (HTTP 4xx business error) counts as the server
 * having decided. Network failures, timeouts, 5xx and protocol errors stay
 * unknown: the write may already be applied, so its envelope is retained. */
export function classifyCommitFailure(error: unknown): CommitFailure {
  const status = isRecord(error) ? error.status : error instanceof ApiError ? error.status : undefined;
  const definitive = isRecord(error) ? error.definitive : error instanceof ApiError ? error.definitive : undefined;
  const rejected = definitive === true
    || (typeof status === 'number' && status >= 400 && status < 500 && definitive !== false);
  if (!rejected) return {kind: 'unknown'};
  const ids = extractSequenceErrorIds(error);
  const reason = extractSequenceErrorReason(error);
  const dialogueConflict = extractSequenceDialogueConflict(error);
  return {kind: 'rejected', code: codeOf(error) ?? 'GENERIC', ...(ids && ids.length ? {ids} : {}),
    ...(reason ? {reason} : {}), ...(dialogueConflict ? {dialogueConflict} : {})};
}

/** An explicit `not_applied` receipt is a definite conclusion; a missing
 * receipt (`applied:false` without `status`) proves nothing. */
export function verdictOfOutcome(outcome: RequestOutcome): LostVerdict {
  const operation = typeof outcome.operation === 'string' ? outcome.operation : null;
  if (outcome.status === 'not_applied') return {kind: 'not_applied', code: outcome.code ?? 'SEQUENCE_EDIT_PATCH_INVALID', operation};
  if (outcome.status === 'applied' || outcome.applied === true) return {kind: 'applied', operation};
  return {kind: 'unknown'};
}

export function withReadTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('LOST_RESPONSE_READ_TIMEOUT')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/** One retained format-5 edit. Only the session that committed it is called
 * back to retry it; the shared instance keeps at most one unknown edit so the
 * whole workspace has a single unconfirmed state. */
export class LostResponseState {
  private entry: RetainedSequenceEdit | null = null;
  private retryAction: (() => Promise<LostRetryResult>) | null = null;
  private readonly readOutcome: LostResponseOptions['readOutcome'];
  private readonly readTimeoutMs: number;
  private readonly onChange: LostResponseOptions['onChange'];
  private readonly onNoop: LostResponseOptions['onNoop'];

  constructor(options: LostResponseOptions = {}) {
    this.readOutcome = options.readOutcome;
    this.readTimeoutMs = options.readTimeoutMs ?? LOST_RESPONSE_READ_TIMEOUT_MS;
    this.onChange = options.onChange;
    this.onNoop = options.onNoop;
  }

  get view(): LostResponseView | null {
    return this.entry ? {projectId: this.entry.projectId, requestId: this.entry.requestId} : null;
  }
  get retained(): RetainedSequenceEdit | null {return this.entry}

  retain(entry: RetainedSequenceEdit, retry: () => Promise<LostRetryResult>): void {
    const previous = this.view;
    this.entry = entry;
    this.retryAction = retry;
    if (previous?.projectId !== entry.projectId || previous?.requestId !== entry.requestId) {
      this.onChange?.({projectId: entry.projectId, requestId: entry.requestId});
    }
  }

  clear(): void {
    if (!this.entry) return;
    this.entry = null;
    this.retryAction = null;
    this.onChange?.(null);
  }

  /** At most one bounded read; a definite verdict clears the retained edit. */
  async reconcileOnce(current: () => boolean): Promise<LostVerdict> {
    const entry = this.entry;
    if (!entry || !this.readOutcome || !current()) return {kind: 'unknown'};
    let verdict: LostVerdict;
    try {
      const outcome = await withReadTimeout(this.readOutcome({projectId: entry.projectId, requestId: entry.requestId}),
        this.readTimeoutMs);
      if (!current()) return {kind: 'unknown'};
      verdict = verdictOfOutcome(outcome);
    } catch {
      return {kind: 'unknown'};
    }
    if (verdict.kind !== 'unknown') this.clear();
    if (verdict.kind === 'not_applied' && isSequenceEditNoop(verdict)) await this.onNoop?.(entry.projectId);
    return verdict;
  }

  /** The bar's retry action: the committing session resends the retained
   * envelope; when it is still unknown the same envelope stays retained. */
  async retry(): Promise<LostRetryResult> {
    const action = this.retryAction;
    if (!action) return {ok: false, code: UNCONFIRMED_CODE, unconfirmed: true};
    return action();
  }

  /** The bar's abandon action drops the retained edit without writing. */
  abandon(): void {this.clear()}
}

export type ParsedSequenceCommit =
  | {readonly kind: 'success'; readonly actionId: string | null; readonly operation: string;
      readonly patch: unknown; readonly receipt?: SequenceEditReceipt}
  | {readonly kind: 'failure'; readonly code: string; readonly ids?: readonly string[]; readonly reason?: string;
      readonly dialogueConflict?: SequenceDialogueConflict}
  | {readonly kind: 'unknown'};

/** Parse one `sequence.commit` response into its three honest states. Both the
 * timeline/board receipt and the `{ok,receipt}` wrapper the older UI-B flow
 * accepted are understood; anything else is unknown, never a rejection. */
export function parseSequenceCommit(value: unknown): ParsedSequenceCommit {
  if (isRecord(value)) {
    if (value.ok === false) {
      const reason = extractSequenceErrorReason(value);
      const dialogueConflict = extractSequenceDialogueConflict(value);
      return {kind: 'failure', code: String(value.code ?? 'SEQUENCE_EDIT_PATCH_INVALID'),
        ids: extractSequenceErrorIds(value), ...(reason ? {reason} : {}), ...(dialogueConflict ? {dialogueConflict} : {})};
    }
    const receipt = isRecord(value.receipt) ? value.receipt : null;
    const settled = receipt ?? value;
    if (settled.status === 'not_applied') {
      const evidence = isRecord(settled.failure) ? settled.failure : settled;
      const reason = extractSequenceErrorReason(evidence);
      const dialogueConflict = extractSequenceDialogueConflict(settled);
      return {kind: 'failure', code: codeOf(settled) ?? 'SEQUENCE_EDIT_PATCH_INVALID',
        ids: extractSequenceErrorIds(evidence), ...(reason ? {reason} : {}), ...(dialogueConflict ? {dialogueConflict} : {})};
    }
    if (receipt) return {kind: 'success', actionId: String(value.actionId ?? receipt.actionId),
      operation: String(value.operation ?? receipt.operation), patch: value.patch,
      receipt: receipt as unknown as SequenceEditReceipt};
    if (value.status === 'applied') return {kind: 'success',
      actionId: value.actionId === undefined ? null : String(value.actionId),
      operation: String(value.operation ?? 'sequence.edit'), patch: undefined,
      receipt: value as unknown as SequenceEditReceipt};
  }
  return {kind: 'unknown'};
}
