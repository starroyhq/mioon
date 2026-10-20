import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {discoverTests, executeCommand, toolingEnvironment} from '../../scripts/lib/local-tooling.ts';
import type {CommandSpec} from '../../scripts/lib/local-tooling.ts';

export interface ShardOptions {index: number; count: number}
export interface ShardReport {
  schema: 1;
  sourceSha: string;
  fullListSha256: string;
  fullCount: number;
  shardIndex: number;
  shardCount: number;
  selectedCount: number;
  files: string[];
}
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
    const match = /^--(index|count)=(0|[1-9]\d*)$/.exec(arg);
    if (!match || values.has(match[1]!)) fail('INVALID_SHARD_ARGUMENTS');
    values.set(match[1]!, Number(match[2]));
  }
  const index = values.get('index'), count = values.get('count');
  if (index === undefined || count === undefined) fail('INVALID_SHARD_ARGUMENTS');
  validateCount(count);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) fail('INVALID_SHARD_INDEX');
  return {index, count};
}
export function verifyFullPartition(full: readonly string[], shards: readonly (readonly string[])[]): void {
  const expected = catalog(full);
  validateCount(shards.length);
  const union = shards.flat();
  if (shards.some(files => files.length === 0) || union.length !== expected.length || new Set(union).size !== expected.length ||
      JSON.stringify([...union].sort()) !== JSON.stringify(expected)) fail('INCOMPLETE_TEST_PARTITION');
}
export function partitionFullTests(full: readonly string[], count: number): string[][] {
  validateCount(count);
  const sorted = catalog(full);
  const shards = Array.from({length: count}, (_, index) => sorted.filter((_file, position) => position % count === index));
  verifyFullPartition(sorted, shards);
  return shards;
}
export function shardReport(full: readonly string[], options: ShardOptions, sourceSha: string): ShardReport {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) fail('INVALID_SOURCE_SHA');
  const shards = partitionFullTests(full, options.count);
  if (!Number.isSafeInteger(options.index) || options.index < 0 || options.index >= shards.length) fail('INVALID_SHARD_INDEX');
  const sorted = catalog(full), files = shards[options.index]!;
  return {schema: 1, sourceSha, fullListSha256: createHash('sha256').update(sorted.join('\n') + '\n').digest('hex'),
    fullCount: sorted.length, shardIndex: options.index, shardCount: options.count, selectedCount: files.length, files};
}
export function shardCommand(root: string, files: readonly string[], execPath = process.execPath): CommandSpec {
  const selected = catalog(files);
  return {command: execPath, cwd: root, args: [path.join(root, 'scripts/tooling.ts'), 'test', '--suite=full', '--concurrency=1', '--reporter=tap',
    ...selected.map(file => `--file=${file.slice('tests/'.length)}`)]};
}
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseShardArguments(args), root = fileURLToPath(new URL('../../', import.meta.url));
  const full = await discoverTests(root, {suite: 'full'});
  const environment = toolingEnvironment(process.env, {mediaPaths: true});
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const report = shardReport(full, options, sourceSha);
  // Reuse the full lane's own selection validation before launching any test.
  const admitted = await discoverTests(root, {suite: 'full', files: report.files.map(file => file.slice('tests/'.length))});
  if (JSON.stringify(admitted) !== JSON.stringify(report.files)) fail('SHARD_SELECTION_MISMATCH');
  const output = path.join(root, `artifacts/checks-linux-${options.index}/shard.json`);
  await mkdir(path.dirname(output), {recursive: true});
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  process.stdout.write(`Full test shard ${options.index}/${options.count}: ${report.selectedCount}/${report.fullCount} files; catalog SHA256 ${report.fullListSha256}\n`);
  return (await executeCommand(shardCommand(root, report.files), {env: environment})).code;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => {process.exitCode = code;}).catch(() => {console.error('TEST_SHARD_FAILED'); process.exitCode = 1;});
}
