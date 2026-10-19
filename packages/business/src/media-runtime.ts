import { mediaConfigurationError, mediaExecutable } from './media-environment.ts';
import { createStreamingMediaRuntime } from './media-streaming-runtime.ts';
import { spawnMedia, mediaInterrupted, onMediaInterruption, interruptedMediaError, throwIfMediaAborted, terminateMediaProcess } from './media-processes.ts';
import type { ManagedMediaChild, PipedMediaChild } from './media-processes.ts';

export const MEDIA_RUNTIME_LIMITS = Object.freeze({ stdoutBytes: 4 * 1024 * 1024, streamingStdoutBytes: 600 * 48000 * 2 * 4, stderrBytes: 1024 * 1024, stderrTailBytes: 16 * 1024, timeoutMs: 120000 });
export const MEDIA_PULL_CHUNK_BYTES = 1024 * 1024;

/** Trusted synchronous fence supplied by backend-owned callers. */
export type MediaEffectFence = (signal?: AbortSignal) => unknown;
export interface MediaRuntimeError extends Error {
  code: string;
  terminationUnconfirmed?: boolean;
}
export interface MediaRunOptions {
  timeout?: number;
  signal?: AbortSignal | null;
  beforeSpawn?: MediaEffectFence;
  beforeEffect?: MediaEffectFence;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}
export interface MediaStreamingRunOptions extends MediaRunOptions {
  onStdout?: (chunk: Buffer) => unknown;
}
export interface MediaStreamingRunResult { stdoutBytes: number }

const mediaError = (code: string, message: string): MediaRuntimeError => Object.assign(new Error(message), { code });
const isInterrupted = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === 'MEDIA_CANCELLED';
const isTerminationUnconfirmed = (error: unknown): error is MediaRuntimeError => typeof error === 'object' && error !== null && 'terminationUnconfirmed' in error;
export const isMediaEffectRestriction = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') return false;
  return ['RESTORE_OPERATION_UNAVAILABLE', 'RESTORED_RECORD_HELD', 'RESTORE_WORKSPACE_ORIGIN_REQUIRED', 'RESTORE_WORKSPACE_ORIGIN_MISMATCH'].includes(error.code);
};
// Backend-owned invocation/claim fences are synchronous. A Promise is not an
// admission token: do not let an expired caller schedule an effect after await.
export function checkMediaEffect(beforeEffect: MediaEffectFence | undefined, signal?: AbortSignal | null): void {
  throwIfMediaAborted(signal);
  if (beforeEffect !== undefined && typeof beforeEffect !== 'function') throw mediaConfigurationError();
  const result = beforeEffect?.(signal ?? undefined);
  if (result != null && typeof (result as PromiseLike<unknown>).then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw mediaConfigurationError();
  }
  throwIfMediaAborted(signal);
}
const byteLimit = (value: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw mediaConfigurationError();
  return value;
};

interface RunMediaOptions {
  timeout: number;
  signal: AbortSignal | null | undefined;
  beforeSpawn: MediaEffectFence | undefined;
  beforeEffect: MediaEffectFence | undefined;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

/** Bounded, shell-free runner. Errors never contain child output, argv or paths. */
export async function run(command: string, args: readonly string[], { timeout = MEDIA_RUNTIME_LIMITS.timeoutMs, signal, beforeSpawn, beforeEffect,
  maxStdoutBytes = MEDIA_RUNTIME_LIMITS.stdoutBytes, maxStderrBytes = MEDIA_RUNTIME_LIMITS.stderrBytes }: MediaRunOptions = {}): Promise<string> {
  return runMedia(command, args, { timeout, signal, beforeSpawn, beforeEffect, maxStdoutBytes, maxStderrBytes }, undefined);
}

/** Consume bounded binary stdout synchronously, without retaining its chunks.
 * Callback failures stop/reap the exact child and produce a safe error. Async
 * callbacks are rejected: their queued work could otherwise grow without bound.
 * The larger streaming ceiling never applies to the buffered run() API.
 */
export async function runStreaming(command: string, args: readonly string[], { onStdout, timeout = MEDIA_RUNTIME_LIMITS.timeoutMs, signal, beforeSpawn, beforeEffect,
  maxStdoutBytes = MEDIA_RUNTIME_LIMITS.stdoutBytes, maxStderrBytes = MEDIA_RUNTIME_LIMITS.stderrBytes }: MediaStreamingRunOptions = {}): Promise<MediaStreamingRunResult> {
  throwIfMediaAborted(signal);
  if (typeof onStdout !== 'function') throw mediaConfigurationError();
  return runMedia(command, args, { timeout, signal, beforeSpawn, beforeEffect, maxStdoutBytes, maxStderrBytes }, onStdout);
}

// Keep the legacy runner contracts above intact; the awaited pipe lane owns
// its state and validation in a separately checked TypeScript implementation.
export const runStreamingWithBackpressure = createStreamingMediaRuntime({
  limits: MEDIA_RUNTIME_LIMITS, pullChunkBytes: MEDIA_PULL_CHUNK_BYTES,
  mediaConfigurationError, mediaExecutable, checkMediaEffect, throwIfMediaAborted,
  spawnMedia, mediaInterrupted, onMediaInterruption, interruptedMediaError, terminateMediaProcess,
});

function runMedia(command: string, args: readonly string[], { timeout, signal, beforeSpawn, beforeEffect, maxStdoutBytes, maxStderrBytes }: RunMediaOptions, onStdout: undefined): Promise<string>;
function runMedia(command: string, args: readonly string[], { timeout, signal, beforeSpawn, beforeEffect, maxStdoutBytes, maxStderrBytes }: RunMediaOptions, onStdout: (chunk: Buffer) => unknown): Promise<MediaStreamingRunResult>;
function runMedia(command: string, args: readonly string[], { timeout, signal, beforeSpawn, beforeEffect, maxStdoutBytes, maxStderrBytes }: RunMediaOptions, onStdout?: ((chunk: Buffer) => unknown) | undefined): Promise<string | MediaStreamingRunResult> {
  throwIfMediaAborted(signal);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647 || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw mediaConfigurationError();
  const stdoutLimit = byteLimit(maxStdoutBytes, onStdout ? MEDIA_RUNTIME_LIMITS.streamingStdoutBytes : MEDIA_RUNTIME_LIMITS.stdoutBytes), stderrLimit = byteLimit(maxStderrBytes, MEDIA_RUNTIME_LIMITS.stderrBytes);
  const executable = mediaExecutable(command);
  return new Promise<string | MediaStreamingRunResult>((resolve, reject) => {
    let child: PipedMediaChild | undefined, timer: ReturnType<typeof setTimeout> | undefined, removeInterruptionObserver: (() => boolean) | undefined;
    let settled = false, failure: { error: unknown } | undefined, stdoutBytes = 0, stderrBytes = 0, stderrTail = Buffer.alloc(0);
    const stdout: Buffer[] | null = onStdout ? null : [];
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      removeInterruptionObserver?.();
      if (!failure && child && mediaInterrupted(child)) failure = { error: interruptedMediaError() };
      if (!failure && beforeEffect !== undefined) {
        try { checkMediaEffect(beforeEffect, signal); } catch (error) { failure = { error }; }
      }
      if (failure) reject(failure.error);
      else if (stdout) resolve(Buffer.concat(stdout, stdoutBytes).toString('utf8'));
      else resolve({ stdoutBytes });
    };
    const stop = (error: unknown): void => {
      if (settled || failure) return;
      const stopped = { error };
      failure = stopped;
      clearTimeout(timer);
      const activeChild = child;
      if (!activeChild) return;
      // Wait for this exact child's observed exit or the fixed reap deadline.
      void terminateMediaProcess(activeChild, { interrupted: isInterrupted(error) }).then(result => {
        if (result.status === 'unconfirmed') {
          if (typeof stopped.error === 'object' && stopped.error !== null) Object.assign(stopped.error, { terminationUnconfirmed: true });
          else stopped.error = mediaError('MEDIA_PROCESS_FAILED', 'Local media tool could not complete.');
        }
        activeChild.stdout?.destroy(); activeChild.stderr?.destroy();
        finish();
      });
    };
    const abort = (): void => stop(interruptedMediaError());
    // Keep callback failures outside spawn-error sanitization. There is no
    // await between these fences and the actual child creation.
    try { checkMediaEffect(beforeSpawn, signal); checkMediaEffect(beforeEffect, signal); }
    catch (error) { reject(error); return; }
    try { child = spawnMedia(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] }, { kind: command, signal }); }
    catch (error) { reject(isTerminationUnconfirmed(error) ? error : signal?.aborted ? interruptedMediaError() : mediaError('MEDIA_SPAWN_FAILED', 'Could not start the local media tool.')); return; }
    const activeChild: PipedMediaChild = child;
    activeChild.stdout.on('data', (chunk: Buffer) => {
      if (failure || settled) return;
      if (chunk.length > stdoutLimit - stdoutBytes) { stop(mediaError('MEDIA_OUTPUT_LIMIT', 'Local media tool exceeded its output limit.')); return; }
      stdoutBytes += chunk.length;
      if (!onStdout) { stdout?.push(chunk); return; }
      try {
        const result = onStdout(chunk);
        if (result != null && typeof (result as PromiseLike<unknown>).then === 'function') {
          // Observe a rejected async callback even though it is unsupported.
          Promise.resolve(result).catch(() => {});
          stop(mediaConfigurationError());
        }
      } catch (error) { stop(isMediaEffectRestriction(error) ? error : mediaError('MEDIA_STREAM_FAILED', 'Local media output could not be processed.')); }
    });
    activeChild.stderr.on('data', (chunk: Buffer) => {
      if (failure || settled) return;
      if (chunk.length > stderrLimit - stderrBytes) { stop(mediaError('MEDIA_OUTPUT_LIMIT', 'Local media tool exceeded its output limit.')); return; }
      stderrBytes += chunk.length;
      // Diagnostic retention is separately bounded and never attached to errors.
      stderrTail = Buffer.from(chunk.length >= MEDIA_RUNTIME_LIMITS.stderrTailBytes ? chunk.subarray(-MEDIA_RUNTIME_LIMITS.stderrTailBytes) : Buffer.concat([stderrTail, chunk]).subarray(-MEDIA_RUNTIME_LIMITS.stderrTailBytes));
    });
    const streamError = (): void => stop(mediaError('MEDIA_PROCESS_FAILED', 'Local media tool could not complete.'));
    activeChild.stdout.on('error', streamError); activeChild.stderr.on('error', streamError);
    activeChild.on('error', () => {
      if (failure) return;
      if (!activeChild.pid) { failure = { error: mediaError('MEDIA_SPAWN_FAILED', 'Could not start the local media tool.') }; finish(); }
      else stop(mediaError('MEDIA_PROCESS_FAILED', 'Local media tool could not complete.'));
    });
    activeChild.once('close', (code: number | null) => {
      if (!failure && mediaInterrupted(activeChild)) failure = { error: interruptedMediaError() };
      if (!failure && code !== 0) failure = { error: mediaError('MEDIA_EXIT_FAILED', 'Local media tool failed.') };
      finish();
    });
    timer = setTimeout(() => stop(mediaError('MEDIA_TIMEOUT', 'Local media tool timed out.')), timeout);
    removeInterruptionObserver = onMediaInterruption(activeChild, abort);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
