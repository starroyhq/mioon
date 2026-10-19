import { mediaConfigurationError, mediaExecutable } from './media-environment.ts';
import { createStreamingMediaRuntime } from './media-streaming-runtime.ts';
import { spawnMedia, mediaInterrupted, onMediaInterruption, interruptedMediaError, throwIfMediaAborted, terminateMediaProcess } from './media-processes.ts';

export const MEDIA_RUNTIME_LIMITS = Object.freeze({ stdoutBytes: 4 * 1024 * 1024, streamingStdoutBytes: 600 * 48000 * 2 * 4, stderrBytes: 1024 * 1024, stderrTailBytes: 16 * 1024, timeoutMs: 120000 });
export const MEDIA_PULL_CHUNK_BYTES = 1024 * 1024;
const mediaError = (code, message) => Object.assign(new Error(message), { code });
export const isMediaEffectRestriction = error => ['RESTORE_OPERATION_UNAVAILABLE', 'RESTORED_RECORD_HELD', 'RESTORE_WORKSPACE_ORIGIN_REQUIRED', 'RESTORE_WORKSPACE_ORIGIN_MISMATCH'].includes(error?.code);
// Backend-owned invocation/claim fences are synchronous. A Promise is not an
// admission token: do not let an expired caller schedule an effect after await.
export function checkMediaEffect(beforeEffect, signal) {
  throwIfMediaAborted(signal);
  if (beforeEffect !== undefined && typeof beforeEffect !== 'function') throw mediaConfigurationError();
  const result = beforeEffect?.(signal);
  if (result != null && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});
    throw mediaConfigurationError();
  }
  throwIfMediaAborted(signal);
}
const byteLimit = (value, maximum) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw mediaConfigurationError();
  return value;
};

/** Bounded, shell-free runner. Errors never contain child output, argv or paths. */
export async function run(command, args, { timeout = MEDIA_RUNTIME_LIMITS.timeoutMs, signal, beforeSpawn, beforeEffect,
  maxStdoutBytes = MEDIA_RUNTIME_LIMITS.stdoutBytes, maxStderrBytes = MEDIA_RUNTIME_LIMITS.stderrBytes } = {}) {
  return runMedia(command, args, { timeout, signal, beforeSpawn, beforeEffect, maxStdoutBytes, maxStderrBytes });
}

/** Consume bounded binary stdout synchronously, without retaining its chunks.
 * Callback failures stop/reap the exact child and produce a safe error. Async
 * callbacks are rejected: their queued work could otherwise grow without bound.
 * The larger streaming ceiling never applies to the buffered run() API.
 */
export async function runStreaming(command, args, { onStdout, timeout = MEDIA_RUNTIME_LIMITS.timeoutMs, signal, beforeSpawn, beforeEffect,
  maxStdoutBytes = MEDIA_RUNTIME_LIMITS.stdoutBytes, maxStderrBytes = MEDIA_RUNTIME_LIMITS.stderrBytes } = {}) {
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

async function runMedia(command, args, { timeout, signal, beforeSpawn, beforeEffect, maxStdoutBytes, maxStderrBytes }, onStdout) {
  throwIfMediaAborted(signal);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647 || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw mediaConfigurationError();
  const stdoutLimit = byteLimit(maxStdoutBytes, onStdout ? MEDIA_RUNTIME_LIMITS.streamingStdoutBytes : MEDIA_RUNTIME_LIMITS.stdoutBytes), stderrLimit = byteLimit(maxStderrBytes, MEDIA_RUNTIME_LIMITS.stderrBytes);
  const executable = mediaExecutable(command);
  return new Promise((resolve, reject) => {
    let child, timer, removeInterruptionObserver, settled = false, failure, stdoutBytes = 0, stderrBytes = 0, stderrTail = Buffer.alloc(0);
    const stdout = onStdout ? null : [];
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      removeInterruptionObserver?.();
      if (!failure && mediaInterrupted(child)) failure = interruptedMediaError();
      if (!failure && beforeEffect !== undefined) {
        try { checkMediaEffect(beforeEffect, signal); } catch (error) { failure = error; }
      }
      if (failure) reject(failure);
      else resolve(onStdout ? { stdoutBytes } : Buffer.concat(stdout, stdoutBytes).toString('utf8'));
    };
    const stop = error => {
      if (settled || failure) return;
      failure = error;
      clearTimeout(timer);
      // Wait for this exact child's observed exit or the fixed reap deadline.
      void terminateMediaProcess(child, { interrupted: error.code === 'MEDIA_CANCELLED' }).then(result => {
        if (result.status === 'unconfirmed') failure.terminationUnconfirmed = true;
        child.stdout?.destroy(); child.stderr?.destroy();
        finish();
      });
    };
    const abort = () => stop(interruptedMediaError());
    // Keep callback failures outside spawn-error sanitization. There is no
    // await between these fences and the actual child creation.
    try { checkMediaEffect(beforeSpawn, signal); checkMediaEffect(beforeEffect, signal); }
    catch (error) { reject(error); return; }
    try { child = spawnMedia(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] }, { kind: command, signal }); }
    catch (error) { reject(error.terminationUnconfirmed ? error : signal?.aborted ? interruptedMediaError() : mediaError('MEDIA_SPAWN_FAILED', 'Could not start the local media tool.')); return; }
    child.stdout.on('data', chunk => {
      if (failure || settled) return;
      if (chunk.length > stdoutLimit - stdoutBytes) { stop(mediaError('MEDIA_OUTPUT_LIMIT', 'Local media tool exceeded its output limit.')); return; }
      stdoutBytes += chunk.length;
      if (!onStdout) { stdout.push(chunk); return; }
      try {
        const result = onStdout(chunk);
        if (result != null && typeof result.then === 'function') {
          // Observe a rejected async callback even though it is unsupported.
          Promise.resolve(result).catch(() => {});
          stop(mediaConfigurationError());
        }
      } catch (error) { stop(isMediaEffectRestriction(error) ? error : mediaError('MEDIA_STREAM_FAILED', 'Local media output could not be processed.')); }
    });
    child.stderr.on('data', chunk => {
      if (failure || settled) return;
      if (chunk.length > stderrLimit - stderrBytes) { stop(mediaError('MEDIA_OUTPUT_LIMIT', 'Local media tool exceeded its output limit.')); return; }
      stderrBytes += chunk.length;
      // Diagnostic retention is separately bounded and never attached to errors.
      stderrTail = Buffer.from(chunk.length >= MEDIA_RUNTIME_LIMITS.stderrTailBytes ? chunk.subarray(-MEDIA_RUNTIME_LIMITS.stderrTailBytes) : Buffer.concat([stderrTail, chunk]).subarray(-MEDIA_RUNTIME_LIMITS.stderrTailBytes));
    });
    const streamError = () => stop(mediaError('MEDIA_PROCESS_FAILED', 'Local media tool could not complete.'));
    child.stdout.on('error', streamError); child.stderr.on('error', streamError);
    child.on('error', () => {
      if (failure) return;
      if (!child.pid) { failure = mediaError('MEDIA_SPAWN_FAILED', 'Could not start the local media tool.'); finish(); }
      else stop(mediaError('MEDIA_PROCESS_FAILED', 'Local media tool could not complete.'));
    });
    child.once('close', code => {
      if (!failure && mediaInterrupted(child)) failure = interruptedMediaError();
      if (!failure && code !== 0) failure = mediaError('MEDIA_EXIT_FAILED', 'Local media tool failed.');
      finish();
    });
    timer = setTimeout(() => stop(mediaError('MEDIA_TIMEOUT', 'Local media tool timed out.')), timeout);
    removeInterruptionObserver = onMediaInterruption(child, abort);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
