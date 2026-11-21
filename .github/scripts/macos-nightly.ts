/** Run the single-shard macOS nightly full-darwin lane and turn the streamed
 * TAP output into a file/test case failure list.
 *
 * The shard driver applies the reviewed per-file deadlines, runs each
 * EXCLUSIVE_TEST_FILES entry alone first and balances nothing else: nightly is a
 * single shard. This wrapper only observes its output (it never re-runs a file),
 * writes the raw log plus failures.json and appends the step summary.
 */
import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {appendFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export type NightlyFailureKind = 'failed' | 'timeout';

export interface NightlyFailure {
  readonly file: string;
  readonly kind: NightlyFailureKind;
  readonly seconds: number;
  readonly tests: string[];
}

/** A performance budget evaluated by tests/helpers/performance-budget.ts. */
export interface RecordedBudget {
  readonly file: string;
  readonly name: string;
  readonly actual: number;
  readonly budget: number;
  readonly unit: 'ms' | 'bytes';
  readonly passed: boolean;
}

export function parseRecordedBudgets(text: string): RecordedBudget[] {
  const budgets: RecordedBudget[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const value = JSON.parse(line) as Partial<RecordedBudget>;
    if (typeof value.file !== 'string' || typeof value.name !== 'string' || typeof value.actual !== 'number' ||
        typeof value.budget !== 'number' || (value.unit !== 'ms' && value.unit !== 'bytes') || typeof value.passed !== 'boolean') {
      throw new Error('INVALID_PERF_EVIDENCE');
    }
    budgets.push({file: value.file, name: value.name, actual: value.actual, budget: value.budget, unit: value.unit, passed: value.passed});
  }
  return budgets;
}

const startMarker = /^TEST_FILE_START (\S+)$/u;
const failedMarker = /^TEST_FILE_FAILED (\S+) \(([0-9.]+)s\)$/u;
const timeoutMarker = /^TEST_FILE_TIMEOUT (\S+) \(([0-9.]+)s\)$/u;
const failedTest = /^not ok \d+ - (.+)$/u;

/** Parse the shard driver's streamed output into per-file failed test names. */
export function parseNightlyLog(lines: readonly string[]): NightlyFailure[] {
  const failures: NightlyFailure[] = [];
  let current: {file: string; kind: NightlyFailureKind; seconds: number; tests: string[]} | null = null;
  for (const line of lines) {
    const start = startMarker.exec(line);
    if (start) {current = {file: start[1]!, kind: 'failed', seconds: 0, tests: []}; continue;}
    const failed = failedMarker.exec(line);
    if (failed && current && current.file === failed[1]) {
      current.kind = 'failed'; current.seconds = Number(failed[2]!);
      failures.push(current); current = null; continue;
    }
    const timeout = timeoutMarker.exec(line);
    if (timeout && current && current.file === timeout[1]) {
      current.kind = 'timeout'; current.seconds = Number(timeout[2]!);
      failures.push(current); current = null; continue;
    }
    const test = failedTest.exec(line);
    if (test && current && !current.tests.includes(test[1]!)) current.tests.push(test[1]!);
  }
  return failures;
}

export function renderNightlySummary({totalSeconds, exitCode, files, failures, recordedBudgets = [], skipped = []}: {
  readonly totalSeconds: number;
  readonly exitCode: number;
  readonly files: number;
  readonly failures: readonly NightlyFailure[];
  readonly recordedBudgets?: readonly RecordedBudget[];
  readonly skipped?: readonly string[];
}): string {
  const lines = [
    '### macOS nightly full-darwin', '',
    `- duration: ${totalSeconds.toFixed(1)} s`,
    `- selected files: ${files}`,
    `- result: **${exitCode === 0 ? 'pass' : 'fail'}** (exit ${exitCode})`,
    `- failed files: ${failures.length}`,
  ];
  for (const failure of failures) {
    lines.push('', `- \`${failure.file}\` (${failure.kind}, ${failure.seconds.toFixed(1)} s)`);
    for (const name of failure.tests) lines.push(`  - ${name}`);
    if (!failure.tests.length) lines.push('  - (no individual test name captured; see raw log)');
  }
  if (!failures.length) lines.push('', '- no test failures');
  if (skipped.length) {
    lines.push('', '### Skipped by design (platform-independent; Linux CI gates them)', '');
    for (const file of skipped) lines.push(`- \`${file}\` (not repeated on the macOS nightly VM)`);
  }
  if (recordedBudgets.length) {
    lines.push('', '### Performance budgets (macOS VM records only; Linux gates them)', '');
    for (const budget of recordedBudgets) {
      lines.push(`- \`${budget.file}\` :: ${budget.name}: ${budget.actual} ${budget.unit} / budget ${budget.budget} ${budget.unit} (${budget.passed ? 'within' : 'over'})`);
    }
  }
  return lines.join('\n') + '\n';
}

function argument(name: string, args: readonly string[], fallback: string): string {
  const prefix = `--${name}=`;
  const value = args.find(item => item.startsWith(prefix))?.slice(prefix.length);
  return value ?? fallback;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const concurrency = Number(argument('concurrency', args, '3'));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('INVALID_CONCURRENCY');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const logPath = path.join(root, argument('log', args, 'artifacts/macos-nightly/full-darwin.log'));
  const failuresPath = path.join(root, argument('failures', args, 'artifacts/macos-nightly/failures.json'));
  await mkdir(path.dirname(logPath), {recursive: true});
  await mkdir(path.dirname(failuresPath), {recursive: true});
  const log = createWriteStream(logPath, {mode: 0o600});
  const lines: string[] = [];
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(root, '.github/scripts/test-shard.ts'), '--index=0', '--count=1', `--concurrency=${concurrency}`],
    {cwd: root, env: process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let buffered = '';
  const consume = (chunk: Buffer, echo: (text: string) => void): void => {
    log.write(chunk);
    echo(chunk.toString('utf8'));
    buffered += chunk.toString('utf8');
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      lines.push(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
    }
  };
  child.stdout!.on('data', (chunk: Buffer) => consume(chunk, text => process.stdout.write(text)));
  child.stderr!.on('data', (chunk: Buffer) => consume(chunk, text => process.stderr.write(text)));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve(signal ? 1 : Number.isInteger(code) ? code as number : 1));
  });
  if (buffered) lines.push(buffered);
  log.end();
  const totalSeconds = (Date.now() - started) / 1000;
  const failures = parseNightlyLog(lines);
  let files = 0;
  try {
    const shard = JSON.parse(await readFile(path.join(root, 'artifacts/checks-macos-0/shard.json'), 'utf8')) as {selectedCount?: number};
    files = Number(shard.selectedCount ?? 0);
  } catch { /* shard.json is absent when preflight failed before selection */ }
  const evidencePath = process.env.MIOON_PERF_EVIDENCE;
  const recordedBudgets = evidencePath ? parseRecordedBudgets(await readFile(path.join(root, evidencePath), 'utf8').catch(() => '')) : [];
  const skipped = (process.env.MIOON_MACOS_NIGHTLY_SKIP_TESTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  await writeFile(failuresPath, JSON.stringify({schema: 1, durationSeconds: Number(totalSeconds.toFixed(1)), exitCode,
    selectedFiles: files, failures, skippedByDesign: skipped, recordedBudgets}, null, 2) + '\n', {mode: 0o600});
  const summary = renderNightlySummary({totalSeconds, exitCode, files, failures, recordedBudgets, skipped});
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  process.stdout.write(summary);
  return exitCode;
}

if (process.argv[1]?.endsWith('macos-nightly.ts')) {
  main().then(code => {process.exitCode = code;}).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'UNEXPECTED_FAILURE');
    process.exitCode = 1;
  });
}
