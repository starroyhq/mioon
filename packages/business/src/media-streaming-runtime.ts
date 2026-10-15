import type {ChildProcessByStdio} from 'node:child_process';
import type {Readable} from 'node:stream';

type StreamingMediaChild = ChildProcessByStdio<null, Readable, Readable>;
type MediaEffectFence = (signal?: AbortSignal) => unknown;

export interface StreamingMediaOptions {
  onStdout: (chunk: Buffer) => void | Promise<void>;
  timeout?: number;
  signal?: AbortSignal;
  beforeSpawn?: MediaEffectFence;
  beforeEffect?: MediaEffectFence;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  onFailure?: (error: unknown) => void;
}

export interface StreamingMediaResult {stdoutBytes: number}
export type StreamingMediaRunner = (command: string, args: readonly string[], options: StreamingMediaOptions) => Promise<StreamingMediaResult>;

/** The legacy process registry stays behind a narrow injected boundary. The
 * complete asynchronous runner, including its ownership/join state, is checked. */
export interface StreamingMediaDependencies {
  readonly limits: Readonly<{timeoutMs: number; streamingStdoutBytes: number; stderrBytes: number}>;
  readonly pullChunkBytes: number;
  mediaConfigurationError(): Error;
  mediaExecutable(command: string): string;
  checkMediaEffect(beforeEffect: MediaEffectFence | undefined, signal?: AbortSignal): void;
  throwIfMediaAborted(signal?: AbortSignal): void;
  spawnMedia(command: string, args: readonly string[], options: {stdio: ['ignore', 'pipe', 'pipe']}, owner: {kind: string; signal?: AbortSignal}): StreamingMediaChild;
  mediaInterrupted(child: StreamingMediaChild): boolean;
  onMediaInterruption(child: StreamingMediaChild, observer: () => void): () => unknown;
  interruptedMediaError(): Error & {code: string};
  terminateMediaProcess(child: StreamingMediaChild, options: {interrupted: boolean}): Promise<{status: 'exited' | 'unowned' | 'unconfirmed'; forced: boolean}>;
}

const mediaError = (code: string, message: string): Error & {code: string} => Object.assign(new Error(message), {code});
const isCancelled = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 'MEDIA_CANCELLED';
const isTerminationUnconfirmed = (error: unknown): boolean => typeof error === 'object' && error !== null &&
  'terminationUnconfirmed' in error && error.terminationUnconfirmed === true;

/** The continuous-audio lane alone may await its consumer. Consumer
 * backpressure does not spend the active-work timeout; its owner separately
 * enforces an absolute session deadline. */
export function createStreamingMediaRuntime(runtime: StreamingMediaDependencies): StreamingMediaRunner {
  const {limits, pullChunkBytes, mediaConfigurationError, mediaExecutable, checkMediaEffect, throwIfMediaAborted,
    spawnMedia, mediaInterrupted, onMediaInterruption, interruptedMediaError, terminateMediaProcess} = runtime;
  const byteLimit = (value: number, maximum: number): number => {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw mediaConfigurationError();
    return value;
  };
  return async function runStreamingWithBackpressure(command: string, args: readonly string[], options: StreamingMediaOptions | undefined = undefined): Promise<StreamingMediaResult> {
    const {onStdout, timeout = limits.timeoutMs, signal, beforeSpawn, beforeEffect,
      maxStdoutBytes = limits.streamingStdoutBytes, maxStderrBytes = limits.stderrBytes, onFailure} = options ?? {};
    throwIfMediaAborted(signal);
    if (typeof onStdout !== 'function' || !Number.isFinite(timeout) || timeout <= 0 ||
        !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw mediaConfigurationError();
    const stdoutLimit = byteLimit(maxStdoutBytes, limits.streamingStdoutBytes);
    const stderrLimit = byteLimit(maxStderrBytes, limits.stderrBytes);
    const executable = mediaExecutable(command);
    checkMediaEffect(beforeSpawn, signal); checkMediaEffect(beforeEffect, signal);
    return new Promise<StreamingMediaResult>((resolve, reject) => {
      let child: StreamingMediaChild, timer: ReturnType<typeof setTimeout> | undefined, removeObserver: (() => unknown) | undefined;
      // A separate record also retains a consumer's falsy thrown value until
      // its exact callback and child have both settled.
      let failure: {error: unknown} | undefined;
      let settled = false, closed = false, stdoutEnded = false, pending = false, stdoutBytes = 0, stderrBytes = 0;
      const finish = (): void => {
        if (settled || !closed || pending || !failure && !stdoutEnded) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); removeObserver?.();
        if (!failure) {try {checkMediaEffect(beforeEffect, signal);} catch (error) {failure = {error};}}
        if (failure) reject(failure.error); else resolve({stdoutBytes});
      };
      const stop = (error: unknown): void => {
        if (settled || failure) return;
        const stopped = {error}; failure = stopped; clearTimeout(timer);
        // Wake an owner blocked on demand before joining the callback and
        // child. Failure observers cannot take ownership away from cleanup.
        try {onFailure?.(error);} catch { /* cleanup still owns the exact child */ }
        void terminateMediaProcess(child, {interrupted: isCancelled(error)}).then(result => {
          if (result.status !== 'exited') {
            stopped.error = Object.assign(typeof stopped.error === 'object' && stopped.error !== null ? stopped.error :
              mediaError('MEDIA_PROCESS_FAILED', 'Local media tool could not complete.'), {terminationUnconfirmed: true});
          }
          child.stdout.destroy(); child.stderr.destroy();
          // The owner retains global admission fail-closed when close cannot
          // be confirmed. A successful kill alone never releases this gate.
          if (result.status !== 'exited') closed = true;
          finish();
        });
      };
      const arm = (): void => {clearTimeout(timer); timer = setTimeout(() => stop(mediaError('MEDIA_TIMEOUT', 'Local media tool timed out.')), timeout);};
      const abort = (): void => stop(interruptedMediaError());
      try {child = spawnMedia(executable, args, {stdio: ['ignore', 'pipe', 'pipe']}, {kind: command, signal});}
      catch (error) {reject(isTerminationUnconfirmed(error) ? error : mediaError('MEDIA_SPAWN_FAILED', 'Could not start the local media tool.')); return;}
      // Readable/iterator mode owns one callback and its backing allocation,
      // even when Node resumes a paused pipe internally after child exit.
      void (async (): Promise<void> => {
        try {
          if (child.stdout.readableHighWaterMark > pullChunkBytes) throw mediaConfigurationError();
          for await (const value of child.stdout) {
            const chunk: unknown = value;
            if (failure || settled) break;
            clearTimeout(timer); pending = true;
            if (!Buffer.isBuffer(chunk) || chunk.byteLength > pullChunkBytes || chunk.buffer.byteLength > pullChunkBytes ||
                chunk.length > stdoutLimit - stdoutBytes) throw mediaError('MEDIA_OUTPUT_LIMIT', 'Local media tool exceeded its output limit.');
            stdoutBytes += chunk.length; checkMediaEffect(beforeEffect, signal);
            await onStdout(chunk);
            pending = false; if (!failure && !closed) arm();
          }
        } catch (error) {pending = false; stop(error);}
        finally {pending = false; stdoutEnded = true; finish();}
      })();
      child.stderr.on('data', (chunk: unknown) => {
        if (failure || settled) return;
        if (!Buffer.isBuffer(chunk)) {stop(mediaError('MEDIA_PROCESS_FAILED', 'Local media tool could not complete.')); return;}
        stderrBytes += chunk.length;
        if (stderrBytes > stderrLimit) stop(mediaError('MEDIA_OUTPUT_LIMIT', 'Local media tool exceeded its output limit.'));
      });
      child.stdout.on('error', () => stop(mediaError('MEDIA_PROCESS_FAILED', 'Local media tool could not complete.')));
      child.stderr.on('error', () => stop(mediaError('MEDIA_PROCESS_FAILED', 'Local media tool could not complete.')));
      child.on('error', () => {
        if (!child.pid) {failure ??= {error: mediaError('MEDIA_SPAWN_FAILED', 'Could not start the local media tool.')}; closed = true; finish();}
        else stop(mediaError('MEDIA_PROCESS_FAILED', 'Local media tool could not complete.'));
      });
      child.once('close', (code: number | null) => {
        closed = true;
        if (!failure && mediaInterrupted(child)) stop(interruptedMediaError());
        if (!failure && code !== 0) stop(mediaError('MEDIA_EXIT_FAILED', 'Local media tool failed.'));
        finish();
      });
      arm(); removeObserver = onMediaInterruption(child, abort);
      signal?.addEventListener('abort', abort, {once: true}); if (signal?.aborted) abort();
    });
  };
}
