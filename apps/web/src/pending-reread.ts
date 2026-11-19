import {LOCAL_MUTATION_OPERATIONS,TIMELINE_MUTATION_OPERATIONS} from '@mioon/contracts';
import type {PendingEntry,PendingEvidence,PendingVerdict} from './submissions.ts';

export interface RereadOutcome {readonly applied: boolean;readonly operation: string|null}
export interface RereadResult {readonly entry: PendingEntry;readonly verdict: PendingVerdict;readonly operation: string|null}
export interface RereadDeps {
  readonly entries: readonly PendingEntry[];
  readonly readOutcome: (input: {readonly projectId: string;readonly requestId: string},options: {readonly signal?: AbortSignal}) => Promise<RereadOutcome>;
  /** Project epoch / visibility guard, checked before and after every read. */
  readonly current: () => boolean;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
export const PENDING_REREAD_TIMEOUT_MS = 5000;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const includes = (list: readonly string[],value: unknown): boolean => typeof value === 'string' && (list as readonly string[]).includes(value);

/** Only operations whose server side keeps an immutable project-owned receipt
 * are re-read. Paid generations, job retries, exports and renders stay on the
 * existing jobs/exports reconciliation and are never probed here. */
export function shouldReread(entry: PendingEntry): boolean {
  const operation = entry.operation;
  if (operation === 'timeline.render' || operation === 'generation.submit' || operation === 'job.retry' || operation === 'export.create') return false;
  return includes(LOCAL_MUTATION_OPERATIONS,operation) || includes(TIMELINE_MUTATION_OPERATIONS,operation) ||
    operation === 'reference.attach' || operation === 'reference.detach' ||
    operation === 'project.version.save' || operation === 'project.version.restore';
}

function requestIdOf(entry: PendingEntry): string | null {
  const id = isRecord(entry.input) ? entry.input.requestId : undefined;
  return typeof id === 'string' && id.length >= 8 && id.length <= 200 ? id : null;
}

/** One bounded pass over the retained requests. Reads are serial, so a slow or
 * failing receipt lookup can only skip its own entry; no request is ever
 * replayed and no error reaches the UI. */
export async function rereadProjectPending(projectId: string,{entries,readOutcome,current,signal,timeoutMs = PENDING_REREAD_TIMEOUT_MS}: RereadDeps): Promise<readonly RereadResult[]> {
  const results: RereadResult[] = [];
  for (const entry of entries) {
    if (!current() || signal?.aborted) break;
    if (!shouldReread(entry)) continue;
    const requestId = requestIdOf(entry);
    if (!requestId) continue;
    let outcome: RereadOutcome;
    try { outcome = await withTimeout(readOutcome({projectId,requestId},{signal}),timeoutMs); }
    catch { continue; }
    if (!current() || signal?.aborted) break;
    const verdict: PendingVerdict = outcome.applied === true ? 'applied' : 'unknown';
    results.push({entry,verdict,operation: typeof outcome.operation === 'string' ? outcome.operation : null});
  }
  return results;
}

function withTimeout<T>(promise: Promise<T>,timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve,reject) => { timer = setTimeout(() => reject(new Error('PENDING_REREAD_TIMEOUT')),timeoutMs); });
  return Promise.race([promise,timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/** The evidence shape `reconcilePending` accepts, built from one read pass. */
export function rereadEvidence(results: readonly RereadResult[]): PendingEvidence {
  const requestOutcomes = new Map<string,{applied: boolean;operation: string|null}>();
  for (const result of results) {
    const requestId = requestIdOf(result.entry);
    if (!requestId || result.verdict === 'unknown') continue;
    requestOutcomes.set(requestId,{applied: result.verdict === 'applied',operation: result.operation});
  }
  return {requestOutcomes};
}
