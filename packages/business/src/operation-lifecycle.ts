/** Backend-only cancellation fences. No RPC input can supply these options. */
export const SHUTDOWN_BUDGET_MS = 5000;

export interface OperationCancelledError extends Error {
  readonly name: 'AbortError';
  code: string;
  status: number;
  beforeDispatch?: boolean;
}

export function operationCancelled({beforeDispatch = false}: {beforeDispatch?: boolean} = {}): OperationCancelledError {
  return Object.assign(new Error('Operation interrupted by shutdown'), {
    name: 'AbortError' as const, code: 'OPERATION_CANCELLED', status: 503,
    ...(beforeDispatch ? {beforeDispatch: true} : {}),
  });
}

export function checkpoint(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw operationCancelled();
}

/**
 * A non-cooperative adapter may never settle. Only its value/error is observed
 * after cancellation; no abandoned continuation is allowed to publish to SQLite.
 * A short submit-only grace allows an already accepted receipt or an explicit
 * before-dispatch rejection to reach the worker's durable recovery checkpoint.
 */
export function awaitProvider<T>(invoke: () => T | PromiseLike<T>, signal?: AbortSignal | null, {submit = false}: {submit?: boolean} = {}): Promise<T> {
  if(signal?.aborted)throw operationCancelled({beforeDispatch:submit});
  return new Promise<T>((resolve, reject) => {
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (callback: () => void): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback();
      return true;
    };
    const finish = (value: T): void => { settle(() => resolve(value)); };
    const fail = (error: unknown): void => { settle(() => reject(error)); };
    const abort = (): void => {
      if (submit) timer ??= setTimeout(() => fail(operationCancelled()), 50);
      else fail(operationCancelled());
    };
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) { fail(operationCancelled({beforeDispatch: true})); return; }
    try { Promise.resolve(invoke()).then(finish, fail); }
    catch (error) { fail(error); }
  });
}

/** Never report successful shutdown or allow SQLite close after this deadline. */
export async function boundedShutdown<T>(promise: PromiseLike<T> | T, code = 'SHUTDOWN_TIMEOUT'): Promise<Awaited<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(promise), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Shutdown did not finish within its safety budget'), {code})), SHUTDOWN_BUDGET_MS);
    })]);
  } finally { clearTimeout(timer); }
}

export function assertMediaTerminated<T extends {status: string}>(results: readonly T[]): readonly T[] {
  if (results.some(result => result.status !== 'exited')) {
    throw Object.assign(new Error('Owned media process exit could not be confirmed'), {
      code: 'MEDIA_TERMINATION_UNCONFIRMED', terminationUnconfirmed: true,
    });
  }
  return results;
}
