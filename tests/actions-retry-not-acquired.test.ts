import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {
  AGGREGATE_GATE_JOB,
  NOT_ACQUIRED_ANNOTATION,
  classifyRunAttempt,
  renderSummary,
} from '../.github/scripts/retry-not-acquired.ts';
import type {RetryClassification, RunJob} from '../.github/scripts/retry-not-acquired.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const notAcquiredMessage = [NOT_ACQUIRED_ANNOTATION, 'Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times.'];

function job(id: number, name: string, overrides: Partial<RunJob> = {}): RunJob {
  return {id, name, conclusion: 'failure', started_at: '2026-11-19T00:00:00Z', completed_at: '2026-11-19T00:10:00Z',
    runner_name: 'GitHub Actions 1', steps: [{name: 'Set up job', conclusion: 'success'}], check_run_url: null, ...overrides};
}
function queued(id: number, name: string, overrides: Partial<RunJob> = {}): RunJob {
  return job(id, name, {conclusion: 'cancelled', started_at: '2026-11-19T00:00:00Z', completed_at: '2026-11-19T00:15:00Z',
    runner_name: '', steps: [], check_run_url: `https://api.github.com/repos/starroyhq/mioon/check-runs/${id}`, ...overrides});
}
function gate(): RunJob {return job(99, AGGREGATE_GATE_JOB, {conclusion: 'failure'});}
function classify(jobs: RunJob[], attempt = 1, annotations = new Map<number, readonly string[]>()) {
  return classifyRunAttempt({runId: 1, attempt, jobs, annotations});
}
function withMessages(jobs: RunJob[]): ReadonlyMap<number, readonly string[]> {
  return new Map(jobs.filter(item => item && item.steps.length === 0).map(item => [item.id, notAcquiredMessage]));
}

test('a run whose failed jobs were never assigned a runner is eligible for one retry', () => {
  const jobs = [job(1, 'Linux full tests and build (shard 0)', {conclusion: 'success'}), queued(2, 'macOS portable source checks'), gate()];
  const result = classify(jobs, 1, withMessages(jobs));
  assert.equal(result.verdict, 'rerun');
  assert.deepEqual(result.notAcquired, ['macOS portable source checks']);
  assert.deepEqual(result.realFailures, []);
});

test('a real test failure is never retried', () => {
  const jobs = [job(1, 'Linux full tests and build (shard 2)', {steps: Array.from({length: 17}, (_, index) => ({name: `step ${index}`, conclusion: 'failure'}))}), gate()];
  const result = classify(jobs, 1, withMessages(jobs));
  assert.equal(result.verdict, 'skip-real-failure');
  assert.deepEqual(result.realFailures, ['Linux full tests and build (shard 2)']);
});

test('a mixed run is never retried because a rerun would re-run real failures', () => {
  const jobs = [queued(1, 'macOS desktop test group'), job(2, 'Linux full tests and build (shard 4)'), gate()];
  const result = classify(jobs, 1, withMessages(jobs));
  assert.equal(result.verdict, 'skip-mixed');
  assert.deepEqual(result.notAcquired, ['macOS desktop test group']);
  assert.deepEqual(result.realFailures, ['Linux full tests and build (shard 4)']);
});

test('only the first attempt is eligible', () => {
  const jobs = [queued(1, 'macOS desktop test group'), gate()];
  const result = classify(jobs, 2, withMessages(jobs));
  assert.equal(result.verdict, 'skip-not-first-attempt');
});

test('a job without steps but without the exact annotation is not retried', () => {
  const jobs = [queued(1, 'macOS desktop test group'), gate()];
  const result = classify(jobs, 1, new Map([[1, ['Some other infrastructure message']]]));
  assert.equal(result.verdict, 'skip-unknown');
  assert.deepEqual(result.unknownFailures, ['macOS desktop test group']);
});

test('a queued-looking job that actually ran steps counts as a real failure', () => {
  const jobs = [queued(1, 'macOS desktop test group', {steps: [{name: 'Set up job', conclusion: 'failure'}]}), gate()];
  const result = classify(jobs, 1, withMessages(jobs));
  assert.equal(result.verdict, 'skip-real-failure');
});

test('aggregate gate failures alone or a clean run are not retried', () => {
  assert.equal(classify([job(1, 'Linux source checks and build', {conclusion: 'success'}), gate()], 1).verdict, 'skip-unknown');
  assert.equal(classify([job(1, 'Linux source checks and build', {conclusion: 'success'})], 1).verdict, 'skip-no-failure');
});

test('the drill summary records the verdict, expectation and that the rerun API was not called', () => {
  const jobs = [queued(1, 'macOS portable source checks'), gate()];
  const classification: RetryClassification = classify(jobs, 1, withMessages(jobs));
  const summary = renderSummary(classification, 'rerun');
  assert.match(summary, /verdict: \*\*rerun\*\*/);
  assert.match(summary, /expected: \*\*rerun\*\* \(PASS\)/);
  assert.match(summary, /rerun API: \*\*not called\*\* \(drill only\)/);
  const mismatch = renderSummary({...classification, verdict: 'skip-mixed'}, 'rerun');
  assert.match(mismatch, /\(MISMATCH\)/);
});

test('the drill workflow is manual-only, has the approved permission and never calls a rerun endpoint', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/retry-not-acquired.yml'), 'utf8');
  assert.match(workflow, /^on:\r?\n  workflow_dispatch:\r?\n    inputs:\r?\n      run_id:/m);
  assert.doesNotMatch(workflow, /^  workflow_run:|^  pull_request:/m, 'the drill workflow must not react to other workflows or PRs');
  assert.match(workflow, /permissions:\r?\n  actions: write\r?\n  contents: read/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(workflow, /retry-not-acquired\.ts --run-id="\$\{\{ inputs\.run_id \}\}"/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /rerun-failed-jobs|rerun-failed/);
  const script = await readFile(path.join(root, '.github/scripts/retry-not-acquired.ts'), 'utf8');
  assert.match(script, /never calls a rerun API/);
  assert.doesNotMatch(script, /rerun-failed-jobs/);
  assert.equal(NOT_ACQUIRED_ANNOTATION, 'The job was not acquired by Runner of type hosted even after multiple attempts');
});
