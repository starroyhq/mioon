import {spawn} from 'node:child_process';
import path from 'node:path';

const TAIL_LINES = 12;
const LINE_LIMIT = 8192;
const KILL_DRAIN_MS = 1000;

interface RunOptions {
  readonly concurrency: number;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutFor: (file: string) => number;
  readonly write: (text: string) => void;
  readonly signal?: AbortSignal;
}

interface FileResult {
  readonly passed: boolean;
  readonly seconds?: number;
}

function runTestFile(root: string, file: string, {env, timeoutFor, write, signal}: RunOptions): Promise<FileResult> {
  const timeoutMs = timeoutFor(file);
  const rootPrefix = path.resolve(root) + path.sep;
  return new Promise(resolve => {
    const start = performance.now();
    const elapsed = () => Math.round((performance.now() - start) / 10) / 100;
    write(`TEST_FILE_START ${file}\n`);
    // The outer process group isolates each file. Running the entry directly
    // avoids the extra node --test worker and keeps module errors fatal.
    const child = spawn(process.execPath, ['--test-reporter=tap', '--test-concurrency=1', file], {
      cwd: root, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tail: string[] = [];
    const emitLine = (line: string) => {
      const relative = line.replaceAll(rootPrefix, '');
      const safe = /(?:\/Users\/|\/home\/|~\/|\/private\/tmp\/claude-|-Users-)/.test(relative)
        ? '[local path omitted]'
        : relative.length > LINE_LIMIT ? '[long output line omitted]' : relative;
      const text = /^\s*(?:::|##\[)/.test(safe) ? '# ' + safe : safe;
      write(text + '\n');
      if (text.trim()) {
        tail.push(text);
        if (tail.length > TAIL_LINES) tail.shift();
      }
    };
    const flush = [child.stdout, child.stderr].map(stream => {
      let pending = '';
      let overlong = false;
      const flushLine = (line: string) => {
        emitLine(overlong ? '[long output line omitted]' : line);
        overlong = false;
      };
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        const lines = (pending + chunk).split('\n');
        pending = lines.pop()!;
        for (const line of lines) flushLine(line);
        if (overlong || pending.length > LINE_LIMIT) {
          pending = '';
          overlong = true;
        }
      });
      return () => {if (pending || overlong) flushLine(pending); pending = '';};
    });

    let finished = false, stopped = false, timedOutAt: number | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(drain);
      signal?.removeEventListener('abort', abort);
      for (const flushStream of flush) flushStream();
      if (timedOutAt !== undefined) {
        write(`TEST_FILE_TIMEOUT ${file} (${timedOutAt.toFixed(2)}s)\n`);
        for (const line of tail) write(`  ${line}\n`);
        if (!tail.length) write('  (no output)\n');
      } else if (!stopped && code !== 0) {
        write(`TEST_FILE_FAILED ${file} (${elapsed().toFixed(2)}s)\n`);
      }
      resolve(stopped || code === null ? {passed: false} : {passed: code === 0, seconds: elapsed()});
    };
    const stop = () => {
      if (stopped || finished) return;
      stopped = true;
      clearTimeout(deadline);
      if (child.pid !== undefined) {
        try {
          // The spawned group owns the test runner and its inherited descendants.
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') write(`TEST_FILE_KILL_FAILED ${file}\n`);
        }
      }
      // A descendant can outlive its parent's exit and hold the output pipes open.
      // Bound pipe drainage even when a process cannot close its descriptors.
      drain = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null);
      }, KILL_DRAIN_MS);
    };
    const abort = () => stop();
    const deadline = setTimeout(() => {
      timedOutAt = elapsed();
      stop();
    }, timeoutMs);
    signal?.addEventListener('abort', abort, {once: true});
    child.once('error', () => finish(null));
    child.once('close', code => finish(code));
    if (signal?.aborted) abort();
  });
}

/** Run independent POSIX process groups and continue scheduling after file failures. */
export async function runShardFiles(root: string, files: readonly string[], options: RunOptions): Promise<{code: number; timings: Record<string, number>}> {
  if (process.platform === 'win32') throw new Error('SHARD_PROCESS_GROUPS_UNAVAILABLE');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4) throw new Error('INVALID_SHARD_CONCURRENCY');
  let next = 0, code = 0;
  const timings = new Map<string, number>();
  await Promise.all(Array.from({length: Math.min(options.concurrency, files.length)}, async () => {
    while (next < files.length && !options.signal?.aborted) {
      const file = files[next++]!;
      const result = await runTestFile(root, file, options);
      if (!result.passed) code = 1;
      if (result.seconds !== undefined) timings.set(file, result.seconds);
    }
  }));
  return {code, timings: Object.fromEntries([...timings].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))};
}
