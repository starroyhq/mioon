import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {discoverTests, executeCommand, toolingEnvironment} from '../../scripts/lib/local-tooling.ts';
import type {CommandSpec} from '../../scripts/lib/local-tooling.ts';

export interface ShardOptions {index: number; count: number; concurrency?: number}
/** Recorded seconds per test file, from `.github/test-timings.json`. */
export type TestTimings = ReadonlyMap<string, number>;
export interface ShardReport {
  schema: 2;
  sourceSha: string;
  fullListSha256: string;
  timingsSha256: string;
  fullCount: number;
  shardIndex: number;
  shardCount: number;
  selectedCount: number;
  estimatedSeconds: number;
  files: string[];
  exclusiveFiles: string[];
}
export const TIMINGS_FILE = '.github/test-timings.json';
/**
 * Test files that must not share the runner's CPUs; each shard runs its share of them alone, before its other
 * files. With three files at a time a file runs about 1.5 times slower on average and up to about twice as slow,
 * so a test needs real headroom against its own deadline. The list holds files with a test whose serial CI time
 * (main, 2026-10-23) was at least a third of its declared timeout, shown as that share, and files that failed in
 * CI for another reason when sharing CPUs. Add a file only with such evidence.
 */
export const EXCLUSIVE_TEST_FILES: readonly string[] = Object.freeze([
  'tests/asset-disposition-transports.test.ts', // 46%
  'tests/desktop-async-secrets.test.ts', // 40%
  'tests/export-settings-capabilities.test.ts', // 70%
  'tests/export-settings-media.test.ts', // 66%; timed out while sharing CPUs
  'tests/http-file-shutdown.test.ts', // 83%; timed out while sharing CPUs
  'tests/inspection-wire.test.ts', // 35%
  'tests/mock-renderer-capability-fences.test.ts', // 61%
  'tests/races.test.ts', // 62%; timed out while sharing CPUs
  'tests/server-worker-shutdown.test.ts', // 67%
  'tests/test-compile-cache.test.ts', // a self-sent SIGTERM must land while the cache handler is installed
  'tests/timeline-history-transports.test.ts', // 35%
  'tests/timeline-mix-loudness-service-media.test.ts', // 69%; fixed operation budget for a 600-second mix
  'tests/typecheck-runtime.test.ts', // 50%
  'tests/worker-shutdown.test.ts', // 83%; timed out while sharing CPUs
]);
const testPath = /^tests\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.test\.(?:mjs|ts)$/;
function fail(code: string): never {throw new Error(code);}
function validateCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 1 || count > 32) fail('INVALID_SHARD_COUNT');
}
function catalog(files: readonly string[]): string[] {
  if (files.length === 0) fail('EMPTY_FULL_TEST_CATALOG');
  if (files.some(file => !testPath.test(file)) || new Set(files).size !== files.length) fail('INVALID_FULL_TEST_CATALOG');
  return [...files].sort();
}
export function parseShardArguments(args: readonly string[]): ShardOptions {
  const values = new Map<string, number>();
  for (const arg of args) {
    const match = /^--(index|count|concurrency)=(0|[1-9]\d*)$/.exec(arg);
    if (!match || values.has(match[1]!)) fail('INVALID_SHARD_ARGUMENTS');
    values.set(match[1]!, Number(match[2]));
  }
  const index = values.get('index'), count = values.get('count');
  if (index === undefined || count === undefined) fail('INVALID_SHARD_ARGUMENTS');
  validateCount(count);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) fail('INVALID_SHARD_INDEX');
  const concurrency = values.get('concurrency') ?? 1;
  if (concurrency < 1 || concurrency > 4) fail('INVALID_SHARD_CONCURRENCY');
  return {index, count, concurrency};
}
/** Validates the recorded timing table; a malformed table fails the shard instead of silently unbalancing it. */
export function parseTestTimings(text: string): TestTimings {
  let value: unknown;
  try {value = JSON.parse(text);} catch {fail('INVALID_TEST_TIMINGS');}
  const files = value !== null && typeof value === 'object' && (value as {schema?: unknown}).schema === 1 ? (value as {files?: unknown}).files : undefined;
  if (files === null || typeof files !== 'object' || Array.isArray(files)) fail('INVALID_TEST_TIMINGS');
  const timings = new Map<string, number>();
  for (const [file, seconds] of Object.entries(files as Record<string, unknown>)) {
    if (!testPath.test(file) || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 3600) fail('INVALID_TEST_TIMINGS');
    timings.set(file, seconds);
  }
  return timings;
}
export function verifyFullPartition(full: readonly string[], shards: readonly (readonly string[])[]): void {
  const expected = catalog(full);
  validateCount(shards.length);
  const union = shards.flat();
  if (shards.some(files => files.length === 0) || union.length !== expected.length || new Set(union).size !== expected.length ||
      JSON.stringify([...union].sort()) !== JSON.stringify(expected)) fail('INCOMPLETE_TEST_PARTITION');
}
function weightsOf(sorted: readonly string[], timings: TestTimings): number[] {
  // A test file not yet in the table counts as a typical one: the median of the recorded files.
  const known = sorted.map(file => timings.get(file)).filter((seconds): seconds is number => seconds !== undefined).sort((a, b) => a - b);
  const typical = known.length ? known[Math.floor((known.length - 1) / 2)]! : 1;
  return sorted.map(file => timings.get(file) ?? typical);
}
/** Wall time a file adds to its shard: shared files run `concurrency` at a time, exclusive ones alone. */
function costsOf(sorted: readonly string[], timings: TestTimings, concurrency: number): number[] {
  const exclusive = new Set(EXCLUSIVE_TEST_FILES), weights = weightsOf(sorted, timings);
  return sorted.map((file, position) => exclusive.has(file) ? weights[position]! : weights[position]! / concurrency);
}
/**
 * Longest recorded files first, each into the shard with the least recorded time so far (ties: the lower
 * index), so shards finish together. Without timings every file weighs the same and this is the earlier
 * round-robin by sorted name. The result depends only on the catalog, the committed table and the concurrency.
 */
export function partitionFullTests(full: readonly string[], count: number, timings: TestTimings = new Map(), concurrency = 1): string[][] {
  validateCount(count);
  const sorted = catalog(full), weights = costsOf(sorted, timings, concurrency);
  const order = sorted.map((_file, position) => position).sort((a, b) => weights[b]! - weights[a]! || a - b);
  const loads = Array<number>(count).fill(0), shards: string[][] = Array.from({length: count}, () => []);
  for (const position of order) {
    let target = 0;
    for (let index = 1; index < count; index++) if (loads[index]! < loads[target]!) target = index;
    shards[target]!.push(sorted[position]!); loads[target] = loads[target]! + weights[position]!;
  }
  for (const shard of shards) shard.sort();
  verifyFullPartition(sorted, shards);
  return shards;
}
export function shardReport(full: readonly string[], options: ShardOptions, sourceSha: string, timings: TestTimings = new Map(), timingsText = ''): ShardReport {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) fail('INVALID_SOURCE_SHA');
  const concurrency = options.concurrency ?? 1, shards = partitionFullTests(full, options.count, timings, concurrency);
  if (!Number.isSafeInteger(options.index) || options.index < 0 || options.index >= shards.length) fail('INVALID_SHARD_INDEX');
  const sorted = catalog(full), files = shards[options.index]!, costs = costsOf(sorted, timings, concurrency), exclusive = new Set(EXCLUSIVE_TEST_FILES);
  const estimatedSeconds = Math.round(files.reduce((sum, file) => sum + costs[sorted.indexOf(file)]!, 0));
  return {schema: 2, sourceSha, fullListSha256: createHash('sha256').update(sorted.join('\n') + '\n').digest('hex'),
    timingsSha256: createHash('sha256').update(timingsText).digest('hex'),
    fullCount: sorted.length, shardIndex: options.index, shardCount: options.count, selectedCount: files.length, estimatedSeconds, files,
    exclusiveFiles: files.filter(file => exclusive.has(file))};
}
export function shardCommand(root: string, files: readonly string[], execPath = process.execPath, {concurrency = 1, timings}: {concurrency?: number; timings?: string} = {}): CommandSpec {
  const selected = catalog(files);
  return {command: execPath, cwd: root, args: [path.join(root, 'scripts/tooling.ts'), 'test', '--suite=full', `--concurrency=${concurrency}`, '--reporter=tap',
    ...(timings ? [`--timings=${timings}`] : []), ...selected.map(file => `--file=${file.slice('tests/'.length)}`)]};
}
/** The shard's exclusive files alone on a quiet runner, then its shared files `concurrency` at a time; each phase records timings. */
export function shardCommands(root: string, report: Pick<ShardReport, 'files' | 'exclusiveFiles' | 'shardIndex'>, concurrency: number, execPath = process.execPath): CommandSpec[] {
  const directory = `artifacts/checks-linux-${report.shardIndex}`, alone = new Set(report.exclusiveFiles), shared = report.files.filter(file => !alone.has(file));
  return [
    ...(alone.size ? [shardCommand(root, report.exclusiveFiles, execPath, {concurrency: 1, timings: `${directory}/timings-alone.json`})] : []),
    ...(shared.length ? [shardCommand(root, shared, execPath, {concurrency, timings: `${directory}/timings.json`})] : []),
  ];
}
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseShardArguments(args), root = fileURLToPath(new URL('../../', import.meta.url));
  const full = await discoverTests(root, {suite: 'full'});
  const environment = toolingEnvironment(process.env, {mediaPaths: true});
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const timingsText = await readFile(path.join(root, TIMINGS_FILE), 'utf8');
  const report = shardReport(full, options, sourceSha, parseTestTimings(timingsText), timingsText);
  // Reuse the full lane's own selection validation before launching any test.
  const admitted = await discoverTests(root, {suite: 'full', files: report.files.map(file => file.slice('tests/'.length))});
  if (JSON.stringify(admitted) !== JSON.stringify(report.files)) fail('SHARD_SELECTION_MISMATCH');
  const output = path.join(root, `artifacts/checks-linux-${options.index}/shard.json`);
  await mkdir(path.dirname(output), {recursive: true});
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  process.stdout.write(`Full test shard ${options.index}/${options.count}: ${report.selectedCount}/${report.fullCount} files (${report.exclusiveFiles.length} alone), about ${report.estimatedSeconds} s, ${options.concurrency ?? 1} at a time; catalog SHA256 ${report.fullListSha256}\n`);
  // Both phases run so one failure still reports the other; an interrupted phase (signal exit) ends the shard.
  let code = 0;
  for (const command of shardCommands(root, report, options.concurrency ?? 1)) {
    const result = (await executeCommand(command, {env: environment})).code;
    code ||= result;
    if (result >= 128) break;
  }
  return code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => {process.exitCode = code;}).catch(() => {console.error('TEST_SHARD_FAILED'); process.exitCode = 1;});
}
