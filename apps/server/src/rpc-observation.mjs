import {operationEffect} from '@mioon/contracts';

/** Only an advisory read may be stopped by losing its HTTP observer. Never
 * propagate socket lifetime into mutation, generation or render cancellation. */
export async function callObservedRpc(req, res, services, operation, input) {
  if (!['timeline.export.preflight', 'timeline.export.capabilities'].includes(operation)) return services.call(operation, input);
  const effect = operationEffect(operation);
  // Explicit opt-in plus semantic guards: a later effect change cannot silently
  // attach client cancellation to writes or external/paid work. An annotation
  // alone never adds other operations to this narrow observation policy.
  if (!effect.readOnly || effect.databaseWrite || effect.fileWrite || effect.externalIO || effect.paidGeneration)
    return services.call(operation, input);
  const observer = new AbortController();
  const disconnected = () => { if (!res.writableFinished) observer.abort(); };
  const aborted = () => observer.abort();
  req.once('aborted', aborted);
  res.once('close', disconnected);
  try {
    if (req.aborted || res.destroyed) observer.abort();
    return await services.call(operation, input, {signal: observer.signal});
  } finally {
    req.removeListener('aborted', aborted);
    res.removeListener('close', disconnected);
  }
}
