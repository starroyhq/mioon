import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, realpath, rename, rm, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {discoverTests, toolingEnvironment} from '../scripts/lib/local-tooling.ts';
import {parseShardArguments, partitionFullTests, shardCommand, shardReport, verifyFullPartition} from '../.github/scripts/test-shard.ts';

const sourceSha = 'a'.repeat(40);
const files = Array.from({length: 784}, (_, index) => `tests/file-${String(index).padStart(4, '0')}.test.${index % 2 ? 'mjs' : 'ts'}`);
for (const count of [4, 8]) {
  test(`${count} shards include every authoritative full test exactly once`, () => {
    const shards = partitionFullTests(files, count);
    assert.deepEqual(shards.map(shard => shard.length), Array<number>(count).fill(files.length / count));
    assert.equal(new Set(shards.flat()).size, files.length);
    assert.deepEqual(shards.flat().sort(), files);
    for (const [index, shard] of shards.entries()) assert.deepEqual(shard, files.filter((_file, position) => position % count === index));
  });
  test(`${count}-shard catalog ordering cannot change membership or the shared full-list hash`, () => {
    const reversed = [...files].reverse(), reports = Array.from({length: count}, (_, index) => shardReport(reversed, {index, count}, sourceSha));
    assert.equal(new Set(reports.map(report => report.fullListSha256)).size, 1);
    assert.match(reports[0]!.fullListSha256, /^[a-f0-9]{64}$/);
    for (const report of reports) {
      assert.equal(report.sourceSha, sourceSha); assert.equal(report.fullCount, files.length); assert.equal(report.selectedCount, files.length / count);
      assert.deepEqual(report.files, partitionFullTests(files, count)[report.shardIndex]);
    }
  });
}
test('Linux CI matrix and launcher count cover the actual full catalog exactly once', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const workflow = await readFile(path.join(root, '.github/workflows/checks.yml'), 'utf8');
  const quality = /^  quality:\r?\n([\s\S]*?)(?=^  [a-z][\w-]*:\r?\n|(?![\s\S]))/m.exec(workflow)?.[1];
  assert.ok(quality, 'the Linux test job must remain in the shared checks workflow');
  const matrix = /^\s+shard:\s*\[([\d,\s]+)\]\s*$/m.exec(quality);
  const launchers = [...quality.matchAll(/node \.github\/scripts\/test-shard\.ts [^\r\n]*--count=(\d+)(?=\s|$)/g)];
  assert.ok(matrix, 'the complete shard matrix must be explicit');
  assert.equal(launchers.length, 1, 'each matrix job must execute one full-lane partition');
  const indexes = matrix[1]!.split(',').map(value => Number(value.trim())), count = Number(launchers[0]![1]);
  assert.deepEqual(indexes, Array.from({length: count}, (_, index) => index), 'a matrix/count mismatch would silently omit full tests');
  const full = await discoverTests(root, {suite: 'full', platform: 'linux'});
  verifyFullPartition(full, indexes.map(index => shardReport(full, {index, count}, sourceSha).files));
  assert.match(quality, /ref: \$\{\{ inputs\.source_sha \}\}/);
  assert.match(quality, /fetch-depth: 0/);
});
test('actual full discovery automatically admits additions, removals and migration renames without an exclusion list', async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-test-shard-catalog-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const directory = path.join(root, 'tests'); await mkdir(directory);
  for (const name of ['a.test.mjs', 'b.test.ts', 'c.test.mjs', 'd.test.ts', 'e.test.mjs', 'README.md']) await writeFile(path.join(directory, name), 'synthetic catalog only');
  const assertComplete = async (expected: string[]) => {
    const full = await discoverTests(root, {suite: 'full', platform: 'linux'});
    assert.deepEqual(full, expected.sort().map(name => `tests/${name}`));
    const shards = partitionFullTests(full, 4); verifyFullPartition(full, shards);
    assert.deepEqual(shards.flat().sort(), full); assert.equal(new Set(shards.flat()).size, full.length);
    return shardReport(full, {index: 0, count: 4}, sourceSha).fullListSha256;
  };
  const original = await assertComplete(['a.test.mjs', 'b.test.ts', 'c.test.mjs', 'd.test.ts', 'e.test.mjs']);
  await writeFile(path.join(directory, 'new.test.ts'), 'new synthetic catalog only');
  const added = await assertComplete(['a.test.mjs', 'b.test.ts', 'c.test.mjs', 'd.test.ts', 'e.test.mjs', 'new.test.ts']);
  await unlink(path.join(directory, 'b.test.ts'));
  const removed = await assertComplete(['a.test.mjs', 'c.test.mjs', 'd.test.ts', 'e.test.mjs', 'new.test.ts']);
  await rename(path.join(directory, 'c.test.mjs'), path.join(directory, 'c.test.ts'));
  const renamed = await assertComplete(['a.test.mjs', 'c.test.ts', 'd.test.ts', 'e.test.mjs', 'new.test.ts']);
  assert.equal(new Set([original, added, removed, renamed]).size, 4);
});
test('partition proof rejects omitted, duplicated, foreign or empty selections', () => {
  const full = files.slice(0, 8), valid = partitionFullTests(full, 4);
  for (const broken of [valid.slice(0, 3), [valid[0]!, valid[0]!, valid[2]!, valid[3]!], [...valid, []], [valid[0]!, valid[1]!, valid[2]!, ['tests/foreign.test.ts']]]) {
    assert.throws(() => verifyFullPartition(full, broken), /INCOMPLETE_TEST_PARTITION/);
  }
});
test('empty or malformed catalogs and impossible shard counts fail before execution', () => {
  assert.throws(() => partitionFullTests([], 4), /EMPTY_FULL_TEST_CATALOG/);
  for (const full of [[files[0]!, files[0]!], ['tests/../private.test.ts'], ['../a.test.ts'], ['tests/a.test.js'], ['tests/nested/a.test.ts'], ['tests/a.test.ts\n']]) {
    assert.throws(() => partitionFullTests(full, 1), /INVALID_FULL_TEST_CATALOG/);
  }
  for (const count of [0, -1, 1.5, NaN, Infinity, 33]) assert.throws(() => partitionFullTests(files, count), /INVALID_SHARD_COUNT/);
  assert.throws(() => partitionFullTests(files.slice(0, 3), 4), /INCOMPLETE_TEST_PARTITION/);
});
test('CLI accepts only a bounded explicit index and count', () => {
  assert.deepEqual(parseShardArguments(['--index=0', '--count=4']), {index: 0, count: 4});
  assert.deepEqual(parseShardArguments(['--count=4', '--index=3']), {index: 3, count: 4});
  assert.deepEqual(parseShardArguments(['--count=8', '--index=7']), {index: 7, count: 8});
  for (const args of [[], ['--index=0'], ['--count=4'], ['--index=0', '--count=4', '--index=1'], ['--index=0', '--count=4', '--output=/tmp/private'], ['--index=-1', '--count=4'], ['--index=1.5', '--count=4'], ['--index=01', '--count=4'], ['--index=4', '--count=4'], ['--index=0', '--count=0'], ['--index=0', '--count=33'], ['--index=99999999999999999', '--count=4']]) {
    assert.throws(() => parseShardArguments(args), /INVALID_SHARD_(ARGUMENTS|INDEX|COUNT)/);
  }
});
test('report rejects invalid indexes and source identities', () => {
  for (const index of [-1, 4, 1.5, NaN]) assert.throws(() => shardReport(files, {index, count: 4}, sourceSha), /INVALID_SHARD_INDEX/);
  for (const sha of ['', 'main', 'b'.repeat(39), 'z'.repeat(40), 'a'.repeat(40) + '\n']) assert.throws(() => shardReport(files, {index: 0, count: 4}, sha), /INVALID_SOURCE_SHA/);
});
test('test launcher preserves the full lane, process isolation and one-file concurrency', () => {
  const root = path.resolve('synthetic root'), executable = path.resolve('synthetic-node');
  const selected = ['tests/b.test.ts', 'tests/a.test.mjs'];
  assert.deepEqual(shardCommand(root, selected, executable), {command: executable, cwd: root, args: [path.join(root, 'scripts/tooling.ts'), 'test', '--suite=full', '--concurrency=1', '--reporter=tap', '--file=a.test.mjs', '--file=b.test.ts']});
  const environment = toolingEnvironment({PATH: '/usr/bin', HOME: '/owned', NODE_OPTIONS: '--import=private-loader', NODE_PATH: '/private-modules', GH_TOKEN: 'private-gh-token', APPLE_API_KEY: 'private-key', MIOON_FFMPEG_PATH: '/owned/ffmpeg', MIOON_FFPROBE_PATH: '/owned/ffprobe'}, {mediaPaths: true});
  assert.equal(environment.NODE_OPTIONS, undefined); assert.equal(environment.NODE_PATH, undefined); assert.equal(environment.GH_TOKEN, undefined); assert.equal(environment.APPLE_API_KEY, undefined);
  assert.equal(environment.MIOON_FFMPEG_PATH, '/owned/ffmpeg'); assert.equal(environment.MIOON_FFPROBE_PATH, '/owned/ffprobe'); assert.equal(environment.MIOON_ENABLE_LIVE_PROVIDER, '0');
});
