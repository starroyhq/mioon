import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, readFile as readText, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {nightlyGate} from '../.github/scripts/macos-nightly-gate.ts';
import {parseNightlyLog, parseRecordedBudgets, renderNightlySummary} from '../.github/scripts/macos-nightly.ts';
import {nightlySkippedTests} from '../.github/scripts/test-shard.ts';
import {budgetPassed, checkPerformanceBudget} from './helpers/performance-budget.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = (letter: string): string => letter.repeat(40);

test('the nightly gate runs when main advanced or no nightly succeeded yet', () => {
  assert.deepEqual(nightlyGate({eventName: 'schedule', currentMainSha: sha('a'), latestSuccessSha: sha('b')}).run, true);
  assert.deepEqual(nightlyGate({eventName: 'schedule', currentMainSha: sha('a'), latestSuccessSha: null}).run, true);
  assert.match(nightlyGate({eventName: 'schedule', currentMainSha: sha('a'), latestSuccessSha: null}).reason, /no previous successful nightly/);
});

test('the nightly gate skips only a scheduled run whose main revision already succeeded', () => {
  const decision = nightlyGate({eventName: 'schedule', currentMainSha: sha('a'), latestSuccessSha: sha('a')});
  assert.equal(decision.run, false);
  assert.match(decision.reason, /unchanged/);
  assert.equal(nightlyGate({eventName: 'workflow_dispatch', currentMainSha: sha('a'), latestSuccessSha: sha('a')}).run, true);
  assert.equal(nightlyGate({eventName: 'push', currentMainSha: sha('a'), latestSuccessSha: sha('a')}).run, true);
  assert.equal(nightlyGate({eventName: 'workflow_call', currentMainSha: sha('a'), latestSuccessSha: null}).run, false);
});

test('the nightly gate rejects malformed revisions', () => {
  assert.throws(() => nightlyGate({eventName: 'schedule', currentMainSha: 'abc', latestSuccessSha: null}), /INVALID_MAIN_SHA/);
  assert.throws(() => nightlyGate({eventName: 'schedule', currentMainSha: sha('a'), latestSuccessSha: 'abc'}), /INVALID_SUCCESS_SHA/);
});

test('the shard log parser lists failed files with their failing test names', () => {
  const failures = parseNightlyLog([
    'Full test shard 0/1: 1163/1163 files (21 alone), about 4800 s, 3 at a time; catalog SHA256 abc',
    'TEST_FILE_START tests/b.test.ts',
    'TAP version 13',
    'ok 1 - passes',
    'not ok 2 - fails one',
    'not ok 3 - fails two',
    'not ok 3 - fails two',
    'TEST_FILE_FAILED tests/b.test.ts (12.34s)',
    'TEST_FILE_START tests/a.test.ts',
    'ok 1 - passes',
    'TEST_FILE_START tests/c.test.ts',
    'TAP version 13',
    'not ok 1 - timeout case',
    'TEST_FILE_TIMEOUT tests/c.test.ts (600.00s)',
  ]);
  assert.deepEqual(failures, [
    {file: 'tests/b.test.ts', kind: 'failed', seconds: 12.34, tests: ['fails one', 'fails two']},
    {file: 'tests/c.test.ts', kind: 'timeout', seconds: 600, tests: ['timeout case']},
  ]);
});

test('the shard log parser ignores passing files and unstarted failures', () => {
  assert.deepEqual(parseNightlyLog(['not ok 1 - before any file', 'TEST_FILE_START tests/a.test.ts', 'ok 1 - passes']), []);
  assert.deepEqual(parseNightlyLog([]), []);
});

test('the nightly summary names every failed file and test case', () => {
  const summary = renderNightlySummary({totalSeconds: 4321.5, exitCode: 1, files: 1163, failures: [
    {file: 'tests/b.test.ts', kind: 'failed', seconds: 12.34, tests: ['fails one']},
  ]});
  assert.match(summary, /duration: 4321\.5 s/);
  assert.match(summary, /selected files: 1163/);
  assert.match(summary, /result: \*\*fail\*\*/);
  assert.match(summary, /tests\/b\.test\.ts.*\(failed, 12\.3 s\)/);
  assert.match(summary, /  - fails one/);
  const pass = renderNightlySummary({totalSeconds: 4000, exitCode: 0, files: 1163, failures: []});
  assert.match(pass, /result: \*\*pass\*\*/);
  assert.match(pass, /no test failures/);
});

test('the recorded performance budgets keep actual and budget values for the summary', () => {
  const text = [
    JSON.stringify({file: 'tests/format5-dialogue-performance.test.ts', name: 'K1 dialogue code path p95', actual: 212.9, budget: 100, unit: 'ms', passed: false}),
    JSON.stringify({file: 'tests/project-format5-performance.test.ts', name: 'total p95 with 100 clips', actual: 42, budget: 100, unit: 'ms', passed: true}),
    '',
  ].join('\n');
  assert.deepEqual(parseRecordedBudgets(text), [
    {file: 'tests/format5-dialogue-performance.test.ts', name: 'K1 dialogue code path p95', actual: 212.9, budget: 100, unit: 'ms', passed: false},
    {file: 'tests/project-format5-performance.test.ts', name: 'total p95 with 100 clips', actual: 42, budget: 100, unit: 'ms', passed: true},
  ]);
  assert.throws(() => parseRecordedBudgets('{"file":"tests/a.test.ts"}'), /INVALID_PERF_EVIDENCE/);
});

test('the nightly summary lists recorded budgets and platform-independent skips', () => {
  const summary = renderNightlySummary({totalSeconds: 60, exitCode: 0, files: 1225, failures: [],
    recordedBudgets: [{file: 'tests/format5-timeline-sync-performance.test.ts', name: 'K1 code path p95', actual: 103.7, budget: 100, unit: 'ms', passed: false}],
    skipped: ['tests/typecheck-runtime.test.ts']});
  assert.match(summary, /Performance budgets \(macOS VM records only; Linux gates them\)/);
  assert.match(summary, /K1 code path p95: 103\.7 ms \/ budget 100 ms \(over\)/);
  assert.match(summary, /Skipped by design/);
  assert.match(summary, /tests\/typecheck-runtime\.test\.ts/);
});

test('the budget helper records every evaluation and enforces only outside the macOS record-only lane', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-perf-evidence-')), evidence = path.join(directory, 'budgets.jsonl');
  const previous = process.env.MIOON_PERF_EVIDENCE;
  process.env.MIOON_PERF_EVIDENCE = evidence;
  try {
    const passing = {file: 'tests/a.test.ts', name: 'p95', actual: 10, budget: 20, unit: 'ms' as const};
    assert.equal(budgetPassed(passing), true);
    checkPerformanceBudget(passing, {platform: 'linux'});
    checkPerformanceBudget({...passing, actual: 30}, {platform: 'darwin', recordOnly: true});
    const lines = (await readText(evidence, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {actual: number; budget: number; passed: boolean});
    assert.deepEqual(lines.map(line => [line.actual, line.budget, line.passed]), [[10, 20, true], [30, 20, false]]);
    assert.throws(() => checkPerformanceBudget({...passing, actual: 30}, {platform: 'linux'}), /p95 30ms exceeds 20ms budget/);
    assert.throws(() => checkPerformanceBudget({...passing, actual: 30}, {platform: 'darwin', recordOnly: false}), /p95 30ms exceeds 20ms budget/);
    assert.doesNotThrow(() => checkPerformanceBudget({...passing, actual: 30}, {platform: 'darwin', recordOnly: true}));
  } finally {
    if (previous === undefined) delete process.env.MIOON_PERF_EVIDENCE; else process.env.MIOON_PERF_EVIDENCE = previous;
    await rm(directory, {recursive: true, force: true});
  }
});

test('the nightly skip list only applies on darwin and rejects malformed selections', () => {
  const source = {MIOON_MACOS_NIGHTLY_SKIP_TESTS: 'tests/typecheck-runtime.test.ts'};
  assert.deepEqual(nightlySkippedTests(source, 'darwin'), ['tests/typecheck-runtime.test.ts']);
  assert.deepEqual(nightlySkippedTests(source, 'linux'), []);
  assert.deepEqual(nightlySkippedTests({}, 'darwin'), []);
  assert.throws(() => nightlySkippedTests({MIOON_MACOS_NIGHTLY_SKIP_TESTS: 'tests/nope.ts'}, 'darwin'), /INVALID_NIGHTLY_SKIP_TESTS/);
  assert.throws(() => nightlySkippedTests({MIOON_MACOS_NIGHTLY_SKIP_TESTS: '/etc/passwd'}, 'darwin'), /INVALID_NIGHTLY_SKIP_TESTS/);
});

function workflowJob(workflow: string, name: string): string {
  const value = new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\r?\\n|(?![\\s\\S]))`, 'm').exec(workflow)?.[1];
  assert.ok(value, `the ${name} job must exist`);
  return value;
}

test('the nightly workflow runs on schedule plus manual dispatch with its own concurrency group', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/macos-nightly.yml'), 'utf8');
  assert.match(workflow, /^name: macOS nightly full$/m);
  assert.match(workflow, /^on:\r?\n  schedule:\r?\n    - cron: '0 18 \* \* \*'\r?\n  workflow_dispatch:$/m);
  assert.doesNotMatch(workflow, /^  (push|pull_request|workflow_run):/m, 'the reviewed nightly is schedule + manual dispatch only');
  assert.match(workflow, /^permissions:\r?\n  contents: read$/m);
  assert.match(workflow, /^concurrency:\r?\n  group: macos-nightly\r?\n  cancel-in-progress: false$/m);
  const full = workflowJob(workflow, 'full');
  assert.match(full, /runs-on: macos-15/);
  assert.match(full, /timeout-minutes: 150/);
  assert.match(full, /MIOON_PERF_RECORD_ONLY: '1'/);
  assert.match(full, /MIOON_PERF_EVIDENCE: artifacts\/macos-nightly\/perf-budgets\.jsonl/);
  assert.match(full, /MIOON_MACOS_NIGHTLY_SKIP_TESTS: tests\/typecheck-runtime\.test\.ts/);
  assert.match(full, /performance budgets are recorded/);
  assert.match(full, /ref: \$\{\{ github\.event_name == 'schedule' && 'main' \|\| github\.ref \}\}/);
  assert.match(full, /fetch-depth: 0/);
  assert.match(full, /persist-credentials: false/);
  assert.match(full, /node \.github\/scripts\/macos-nightly-gate\.ts/);
  assert.match(full, /MACOS_NIGHTLY_WORKFLOW_FILE: macos-nightly\.yml/);
  assert.match(full, /uses: \.\/\.github\/actions\/macos-media-toolchain/);
  assert.match(full, /node \.github\/scripts\/macos-nightly\.ts --concurrency=3/);
  assert.match(full, /artifacts\/macos-nightly\/status\.log/);
  assert.match(full, /name: macos-nightly-evidence-\$\{\{ github\.run_id \}\}/);
  assert.match(full, /artifacts\/checks-macos-0\//);
  assert.match(full, /artifacts\/macos-media-environment\//);
});
