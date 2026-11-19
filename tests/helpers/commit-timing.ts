/** Splits one synchronous shared-transaction call into its native COMMIT
 * execution and the code path before/around it.
 *
 * Linux CI runners occasionally fsync for 100–800 ms on the project file while
 * the deterministic transaction body stays at single-digit milliseconds. The K1
 * benchmarks budget the code path; COMMIT stays a separate diagnostic (and the
 * macOS developer run keeps asserting total, where APFS commit latency is tiny).
 * This observes the owned connection without changing SQL, order or durability.
 */
import {performance} from 'node:perf_hooks';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';

export interface MeasuredCommittedCall<T> {
  readonly value: T;
  readonly totalMs: number;
  /** Wall time inside the native `COMMIT` execution (fsync included). */
  readonly commitMs: number;
  /** Everything else: BEGIN, transaction fences, body, terminal fence/return. */
  readonly codePathMs: number;
  /** A synchronized call must commit exactly once. */
  readonly commits: number;
}
export function measureCommittedCall<T>(store: ProjectStore, run: () => T): MeasuredCommittedCall<T> {
  const database = store.db as unknown as {exec: (sql: string) => unknown};
  const native = database.exec.bind(database);
  let commitMs = 0, commits = 0;
  database.exec = (sql: string) => {
    if (sql !== 'COMMIT') return native(sql);
    const started = performance.now();
    try {return native(sql);}
    finally {commitMs += performance.now() - started; commits++;}
  };
  try {
    const started = performance.now();
    const value = run();
    const totalMs = performance.now() - started;
    return {value, totalMs, commitMs, codePathMs: totalMs - commitMs, commits};
  } finally {database.exec = native;}
}

export interface TimingSummary {readonly p50: number; readonly p95: number; readonly max: number}
export function summarizeTiming(values: readonly number[]): TimingSummary {
  const sorted = [...values].sort((left, right) => left - right);
  return {p50: Number(sorted[Math.floor(sorted.length * .5)]!.toFixed(2)),
    p95: Number(sorted[Math.floor(sorted.length * .95)]!.toFixed(2)),
    max: Number(sorted.at(-1)!.toFixed(2))};
}
