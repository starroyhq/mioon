import { mediaConfigurationError, mediaExecutable } from './media-environment.mjs';
import { spawnMedia, mediaInterrupted, onMediaInterruption, interruptedMediaError, throwIfMediaAborted, terminateMediaProcess } from './media-processes.mjs';

export const MEDIA_RUNTIME_LIMITS = Object.freeze({ stdoutBytes: 4 * 1024 * 1024, stderrBytes: 1024 * 1024, stderrTailBytes: 16 * 1024, timeoutMs: 120000 });
const mediaError = (code, message) => Object.assign(new Error(message), { code });
const byteLimit = (value, maximum) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw mediaConfigurationError();
  return value;
};

/** Bounded, shell-free runner. Errors never contain child output, argv or paths. */
export async function run(command, args, { timeout = MEDIA_RUNTIME_LIMITS.timeoutMs, signal,
  maxStdoutBytes = MEDIA_RUNTIME_LIMITS.stdoutBytes, maxStderrBytes = MEDIA_RUNTIME_LIMITS.stderrBytes } = {}) {
  throwIfMediaAborted(signal);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647 || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw mediaConfigurationError();
  const stdoutLimit = byteLimit(maxStdoutBytes, MEDIA_RUNTIME_LIMITS.stdoutBytes), stderrLimit = byteLimit(maxStderrBytes, MEDIA_RUNTIME_LIMITS.stderrBytes);
  const executable = mediaExecutable(command);
  return new Promise((resolve, reject) => {
    let child, timer, removeInterruptionObserver, settled = false, failure, stdoutBytes = 0, stderrBytes = 0, stderrTail = Buffer.alloc(0);
    const stdout = [];
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      removeInterruptionObserver?.();
      if (!failure && mediaInterrupted(child)) failure = interruptedMediaError();
      if (failure) reject(failure);
      else resolve(Buffer.concat(stdout, stdoutBytes).toString('utf8'));
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
    try { child = spawnMedia(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] }, { kind: command, signal }); }
    catch (error) { reject(error.terminationUnconfirmed ? error : signal?.aborted ? interruptedMediaError() : mediaError('MEDIA_SPAWN_FAILED', 'Could not start the local media tool.')); return; }
    child.stdout.on('data', chunk => {
      if (failure || settled) return;
      if (chunk.length > stdoutLimit - stdoutBytes) { stop(mediaError('MEDIA_OUTPUT_LIMIT', 'Local media tool exceeded its output limit.')); return; }
      stdoutBytes += chunk.length; stdout.push(chunk);
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
