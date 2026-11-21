/** Performance budget evaluation with an evidence trail.
 *
 * Linux CI is the reference gate: a budget miss fails there. The macOS nightly
 * VM only records the measured value and its budget (same file, same label),
 * because a virtual M1 runner is not the developer-Mac latency reference. Only
 * budget assertions use this helper; functional assertions in the same test
 * files keep failing everywhere.
 */
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';

export interface PerformanceBudget {
  readonly file: string;
  readonly name: string;
  readonly actual: number;
  readonly budget: number;
  readonly unit: 'ms' | 'bytes';
}

export function budgetPassed({actual, budget}: Pick<PerformanceBudget, 'actual' | 'budget'>): boolean {
  return actual <= budget;
}

/** Records the evaluation whenever `MIOON_PERF_EVIDENCE` names an evidence
 * file, then enforces it unless this is the macOS nightly record-only VM. */
export function checkPerformanceBudget(measurement: PerformanceBudget, {platform = process.platform, recordOnly = process.env.MIOON_PERF_RECORD_ONLY === '1'}: {
  readonly platform?: NodeJS.Platform;
  readonly recordOnly?: boolean;
} = {}): void {
  const passed = budgetPassed(measurement);
  const evidence = process.env.MIOON_PERF_EVIDENCE;
  if (evidence) appendFileSync(evidence, JSON.stringify({...measurement, passed}) + '\n');
  if (recordOnly && platform === 'darwin') return;
  assert.ok(passed, `${measurement.name} ${measurement.actual}${measurement.unit} exceeds ${measurement.budget}${measurement.unit} budget`);
}
