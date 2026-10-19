import type {IncomingMessage, ServerResponse} from 'node:http';
import {operationEffect} from '@mioon/contracts';

/** Minimal transport surface shared by ordinary and verified candidate services. */
export interface ObservedRpcService {
  call(operation: string, input: unknown, context?: Record<string, unknown>): Promise<unknown>;
}
/** Only an advisory read may be stopped by losing its HTTP observer. Never
 * propagate socket lifetime into mutation, generation or render cancellation. */
export async function callObservedRpc(req: IncomingMessage, res: ServerResponse, services: ObservedRpcService, operation: string, input: unknown, context: Record<string, unknown> = {}): Promise<unknown> {
  if (!['timeline.export.preflight', 'timeline.export.capabilities', 'timeline.export.samplePeak', 'timeline.export.loudness', 'timeline.loudness.prepare', 'timeline.clip.loudness'].includes(operation)) return services.call(operation, input, context);
  const effect = operationEffect(operation);
  // Explicit opt-in plus semantic guards: a later effect change cannot silently
  // attach client cancellation to business writes or external/paid work. Only
  // this fixed capability proof may write its owned temporary synthetic files;
  // it has no persistent task or source/project mutation to cancel. Keep that
  // fileWrite effect truthful without granting arbitrary file writers a signal.
  const privateCapabilityFiles = operation === 'timeline.export.capabilities';
  if (!effect.readOnly || effect.databaseWrite || (effect.fileWrite && !privateCapabilityFiles) ||
      effect.externalIO || effect.paidGeneration || effect.destructive || effect.openWorld)
    return services.call(operation, input, context);
  const observer = new AbortController();
  const disconnected = () => { if (!res.writableFinished) observer.abort(); };
  const aborted = () => observer.abort();
  req.once('aborted', aborted);
  res.once('close', disconnected);
  try {
    if (req.aborted || res.destroyed) observer.abort();
    return await services.call(operation, input, {...context, signal: observer.signal});
  } finally {
    req.removeListener('aborted', aborted);
    res.removeListener('close', disconnected);
  }
}
