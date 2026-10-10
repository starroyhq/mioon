/** Backend-only cancellation fences. No RPC input can supply these options. */
export const SHUTDOWN_BUDGET_MS = 5000;

export function operationCancelled({beforeDispatch = false} = {}) {
  return Object.assign(new Error('Operation interrupted by shutdown'), {
    name: 'AbortError', code: 'OPERATION_CANCELLED', status: 503,
    ...(beforeDispatch ? {beforeDispatch: true} : {}),
  });
}

export function checkpoint(signal) {
  if (signal?.aborted) throw operationCancelled();
}

/**
 * A non-cooperative adapter may never settle. Only its value/error is observed
 * after cancellation; no abandoned continuation is allowed to publish to SQLite.
 * A short submit-only grace allows an already accepted receipt or an explicit
 * before-dispatch rejection to reach the worker's durable recovery checkpoint.
 */
export function awaitProvider(invoke, signal, {submit = false} = {}) {
  if(signal?.aborted)throw operationCancelled({beforeDispatch:submit});
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => {
      if (submit) timer ??= setTimeout(() => finish(reject, operationCancelled()), 50);
      else finish(reject, operationCancelled());
    };
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) { finish(reject, operationCancelled({beforeDispatch: true})); return; }
    try { Promise.resolve(invoke()).then(value => finish(resolve, value), error => finish(reject, error)); }
    catch (error) { finish(reject, error); }
  });
}

/** Never report successful shutdown or allow SQLite close after this deadline. */
export async function boundedShutdown(promise, code = 'SHUTDOWN_TIMEOUT') {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Shutdown did not finish within its safety budget'), {code})), SHUTDOWN_BUDGET_MS);
    })]);
  } finally { clearTimeout(timer); }
}

export function assertMediaTerminated(results) {
  if (results.some(result => result.status !== 'exited')) {
    throw Object.assign(new Error('Owned media process exit could not be confirmed'), {
      code: 'MEDIA_TERMINATION_UNCONFIRMED', terminationUnconfirmed: true,
    });
  }
  return results;
}
