/** Cross-process lock for the K1 wall-clock benchmarks.
 *
 * The Linux shard runner executes three test files concurrently; two 500-shot
 * format-5 benchmark fixtures and their measurements must not share a CPU
 * window, otherwise the accepted p95 budget measures shard scheduling noise.
 * Both benchmark files acquire this lock around their build + measurement.
 */
import {closeSync, openSync, realpathSync, statSync, unlinkSync, writeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const LOCK_PATH = path.join(realpathSync(tmpdir()), 'mioon-k1-benchmark.lock');
const STALE_MS = 15 * 60_000;
const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
export function withK1BenchmarkLock<T>(run: () => T): T {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    try {
      const handle = openSync(LOCK_PATH, 'wx');
      writeSync(handle, `${process.pid} ${new Date().toISOString()}`);
      closeSync(handle);
      break;
    } catch (error) {
      if ((error as {code?: string}).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(LOCK_PATH).mtimeMs > STALE_MS) unlinkSync(LOCK_PATH);
      } catch { /* another process released or replaced it */ }
      if (Date.now() > deadline) throw new Error('timed out waiting for the K1 benchmark lock');
      sleep(100);
    }
  }
  try {
    return run();
  } finally {
    try { unlinkSync(LOCK_PATH); } catch { /* already released */ }
  }
}
