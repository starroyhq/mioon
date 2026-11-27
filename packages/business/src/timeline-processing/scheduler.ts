import type {DatabaseSync} from 'node:sqlite';
import {createProcessingCache} from './cache.ts';

interface Work {
  readonly signal: AbortSignal;
  readonly start: () => Promise<void>;
  readonly finish: (error?: unknown) => void;
  readonly abort: () => void;
}

/** The app admits one reverse encoder at a time, even across project hosts.
 * A writer with unconfirmed termination keeps that slot closed. */
export function createProcessingScheduler() {
  const queue: Work[] = [];
  let working = false, uncertain: unknown;
  function pump(): void {
    if (working) return;
    const job = queue.shift();
    if (!job) return;
    if (uncertain) {
      job.finish(uncertain);
      queue.splice(0).forEach(item => item.finish(uncertain));
      return;
    }
    working = true;
    void Promise.resolve().then(() => {
      job.signal.throwIfAborted();
      return job.start();
    }).then(() => job.finish(), error => {
      if (error && typeof error === 'object' && 'terminationUnconfirmed' in error && error.terminationUnconfirmed) uncertain = error;
      job.finish(error);
    }).finally(() => {working = false; pump();});
  }
  function schedule(signal: AbortSignal, start: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const job: Work = {signal, start, abort, finish(error) {
        signal.removeEventListener('abort', abort);
        if (error === undefined) resolve(); else reject(error);
      }};
      function abort(): void {
        const index = queue.indexOf(job);
        if (index < 0) return;
        queue.splice(index, 1);
        job.finish(signal.reason);
      }
      signal.addEventListener('abort', abort, {once: true});
      queue.push(job);
      pump();
    });
  }
  return {schedule};
}

export type ProcessingScheduler = ReturnType<typeof createProcessingScheduler>;
const applications = new WeakMap<DatabaseSync, {
  directory: string; scheduler: ProcessingScheduler; cache: ReturnType<typeof createProcessingCache>;
}>();
export function processingApplication(db: DatabaseSync, directory: string) {
  const previous = applications.get(db);
  if (previous) {
    if (directory !== previous.directory) throw new TypeError('Processing cache directory changed under its owner');
    return previous;
  }
  const state = {directory, scheduler: createProcessingScheduler(), cache: createProcessingCache(directory)};
  applications.set(db, state);
  return state;
}
