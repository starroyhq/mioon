import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {
  AGGREGATE_GATE_JOB,
  NOT_ACQUIRED_ANNOTATION,
  classifyRunAttempt,
  maybeRerun,
  parsePositiveInteger,
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
function classify(jobs: RunJob[], attempt = 1, annotations: ReadonlyMap<number, readonly string[]> = new Map()) {
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

test('the summary records the verdict, expectation and whether the rerun API was called', () => {
  const jobs = [queued(1, 'macOS portable source checks'), gate()];
  const classification: RetryClassification = classify(jobs, 1, withMessages(jobs));
  const manual = renderSummary(classification, {execute: false, outcome: {called: false}});
  assert.match(manual, /verdict: \*\*rerun\*\*/);
  assert.match(manual, /rerun API: \*\*not called\*\* \(manual read-only drill\)/);
  const autoSkip = renderSummary({...classification, verdict: 'skip-mixed'}, {execute: true, outcome: {called: false}});
  assert.match(autoSkip, /rerun API: \*\*not called\*\* \(skip-mixed\)/);
  const autoCalled = renderSummary(classification, {execute: true, outcome: {called: true}});
  assert.match(autoCalled, /rerun API: \*\*called\*\* \(rerun-failed-jobs accepted\)/);
  const failed = renderSummary(classification, {execute: true, outcome: {called: false, error: 'RERUN_FAILED_500'}});
  assert.match(failed, /rerun API: \*\*failed\*\* \(RERUN_FAILED_500\)/);
  assert.match(renderSummary(classification, {execute: false, outcome: {called: false}, expected: 'rerun'}), /\(PASS\)/);
  assert.match(renderSummary({...classification, verdict: 'skip-mixed'}, {execute: false, outcome: {called: false}, expected: 'rerun'}), /\(MISMATCH\)/);
});

test('run ids arrive as validated environment values, never through shell interpolation', () => {
  assert.equal(parsePositiveInteger('RETRY_RUN_ID', '44558848999'), 44558848999);
  assert.equal(parsePositiveInteger('RETRY_RUN_ATTEMPT', '1'), 1);
  for (const raw of [undefined, '', '0', '-1', '1.5', '123abc', ' 42', '99999999999999999999999']) {
    assert.throws(() => parsePositiveInteger('RETRY_RUN_ID', raw), /INVALID_RETRY_RUN_ID/);
  }
});

test('the rerun API is only called for a rerun verdict in execute mode', async () => {
  const classification = {...classify([queued(1, 'macOS desktop test group'), gate()], 1, new Map([[1, notAcquiredMessage]])), runId: 42};
  const calls: number[] = [];
  const rerunFailedJobs = async (_repository: string, runId: number) => {calls.push(runId);};
  assert.deepEqual(await maybeRerun(classification, {execute: false, repository: 'starroyhq/mioon', rerunFailedJobs}), {called: false});
  assert.deepEqual(calls, []);
  assert.deepEqual(await maybeRerun({...classification, verdict: 'skip-mixed'}, {execute: true, repository: 'starroyhq/mioon', rerunFailedJobs}), {called: false});
  assert.deepEqual(calls, []);
  assert.deepEqual(await maybeRerun(classification, {execute: true, repository: 'starroyhq/mioon', rerunFailedJobs}), {called: true});
  assert.deepEqual(calls, [42]);
  const failed = await maybeRerun(classification, {execute: true, repository: 'starroyhq/mioon',
    rerunFailedJobs: async () => {throw new Error('RERUN_FAILED_500');}});
  assert.deepEqual(failed, {called: false, error: 'RERUN_FAILED_500'});
});

function workflowJob(workflow: string, name: string): string {
  const value = new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\r?\\n|(?![\\s\\S]))`, 'm').exec(workflow)?.[1];
  assert.ok(value, `the ${name} job must exist`);
  return value;
}

test('the workflow separates manual read-only and automatic write permissions', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/retry-not-acquired.yml'), 'utf8');
  assert.match(workflow, /^name: Retry not-acquired runs$/m);
  assert.match(workflow, /^on:\r?\n  workflow_run:\r?\n    workflows: \[CI\]\r?\n    types: \[completed\]\r?\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  (push|pull_request):/m, 'only CI completion and manual dispatch may trigger the retry');
  assert.doesNotMatch(workflow, /^permissions:/m, 'permissions are scoped per job, not to the whole workflow');
  const drill = workflowJob(workflow, 'drill'), auto = workflowJob(workflow, 'auto');
  assert.match(drill, /if: github\.event_name == 'workflow_dispatch'/);
  assert.match(drill, /permissions:\r?\n      actions: read\r?\n      contents: read/);
  assert.match(auto, /if: >-\r?\n      github\.event_name == 'workflow_run' &&\r?\n      github\.event\.workflow_run\.conclusion == 'failure' &&\r?\n      github\.event\.workflow_run\.run_attempt == 1/);
  assert.match(auto, /permissions:\r?\n      actions: write\r?\n      contents: read/);
  for (const job of [drill, auto]) {
    assert.match(job, /ref: main/);
    assert.match(job, /persist-credentials: false/);
    for (const match of job.matchAll(/^\s+run: (.+)$/gm)) assert.doesNotMatch(match[1]!, /\$\{\{/u, 'run ids must not be interpolated into the shell command');
  }
  assert.match(drill, /RETRY_RUN_ID: \$\{\{ inputs\.run_id \}\}/);
  assert.match(drill, /RETRY_RUN_ATTEMPT: '1'/);
  assert.match(auto, /RETRY_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(auto, /RETRY_RUN_ATTEMPT: \$\{\{ github\.event\.workflow_run\.run_attempt \}\}/);
  assert.match(drill, /run: node \.github\/scripts\/retry-not-acquired\.ts$/m);
  assert.match(auto, /run: node \.github\/scripts\/retry-not-acquired\.ts --execute$/m);
  assert.equal(NOT_ACQUIRED_ANNOTATION, 'The job was not acquired by Runner of type hosted even after multiple attempts');
});
