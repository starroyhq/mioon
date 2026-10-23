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
function workflowJob(workflow: string, name: string): string {
  const value = new RegExp(`^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\r?\\n|(?![\\s\\S]))`, 'm').exec(workflow)?.[1];
  assert.ok(value, `the ${name} job must exist`);
  return value;
}
test('Linux CI prepares one exact cached media toolchain before distributing it to every shard', async () => {
  const workflow = await readFile(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');
  const preparation = workflowJob(workflow, 'ffmpeg'), quality = workflowJob(workflow, 'quality');
  assert.match(preparation, /ref: \$\{\{ inputs\.source_sha \}\}/);
  assert.match(preparation, /artifact_name: \$\{\{ steps\.identity\.outputs\.artifact_name \}\}/);
  assert.match(preparation, /build_key: \$\{\{ steps\.identity\.outputs\.cache_key \}\}/);
  assert.match(preparation, /printf 'artifact_name=checks-ffmpeg-%s-%s\\n' "\$GITHUB_RUN_ID" "\$GITHUB_RUN_ATTEMPT" >> "\$GITHUB_OUTPUT"/);
  assert.equal((workflow.match(/node \.github\/scripts\/ffmpeg-toolchain\.ts build/g) ?? []).length, 1, 'only preparation may build FFmpeg');
  assert.match(preparation, /if: steps\.cache\.outputs\.cache-hit != 'true'[\s\S]*?run: node \.github\/scripts\/ffmpeg-toolchain\.ts build/);
  for (const action of ['restore', 'save']) {
    assert.match(preparation, new RegExp(`uses: actions/cache/${action}@[a-f0-9]{40}`));
  }
  assert.equal((preparation.match(/^\s+key: \$\{\{ steps\.identity\.outputs\.cache_key \}\}/gm) ?? []).length, 2);
  assert.doesNotMatch(preparation, /restore-keys:|continue-on-error:/);
  const stages = ['ffmpeg-toolchain.ts identity', 'actions/cache/restore@', 'ffmpeg-toolchain.ts build', 'ffmpeg-toolchain.ts activate', 'media-environment.ts --platform=linux', 'actions/cache/save@', 'Upload verified media toolchain'].map(stage => preparation.indexOf(stage));
  assert.ok(stages.every((position, index) => position >= 0 && (index === 0 || position > stages[index - 1]!)), 'only verified and capability-probed tools may enter the cache or artifact');
  assert.match(preparation, /name: \$\{\{ steps\.identity\.outputs\.artifact_name \}\}/);
  assert.match(preparation, /path: \$\{\{ runner\.temp \}\}\/mioon-ffmpeg-toolchain\//);
  assert.match(preparation, /if-no-files-found: error/);
  assert.match(quality, /name: Linux full tests and build \(shard \$\{\{ matrix\.shard \}\}\)/);
  assert.match(quality, /needs: ffmpeg/);
  assert.match(quality, /MIOON_FFMPEG_BUILD_KEY: \$\{\{ needs\.ffmpeg\.outputs\.build_key \}\}/);
  assert.match(quality, /name: \$\{\{ needs\.ffmpeg\.outputs\.artifact_name \}\}/);
  assert.match(quality, /path: \$\{\{ runner\.temp \}\}\/mioon-ffmpeg-toolchain/);
  assert.ok(quality.indexOf('actions/download-artifact@') < quality.indexOf('ffmpeg-toolchain.ts activate'));
  assert.ok(quality.indexOf('ffmpeg-toolchain.ts activate') < quality.indexOf('media-environment.ts --platform=linux'));
  assert.ok(quality.indexOf('media-environment.ts --platform=linux') < quality.indexOf('test-shard.ts'));
  assert.doesNotMatch(quality, /GITHUB_RUN_ATTEMPT|GITHUB_RUN_ID|github\.run_attempt|github\.run_id|install-ffmpeg\.ts|ffmpeg-toolchain\.ts build/);
  assert.match(workflowJob(workflow, 'portable'), /tests\/actions-ffmpeg-toolchain\.test\.ts/);
});
test('desktop Linux packaging reuses the verified run artifact while the CI gate still requires every check', async () => {
  const [workflow, release, ci] = await Promise.all([
    readFile(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/release-desktop.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  ]);
  assert.match(workflow, /ffmpeg_artifact:[\s\S]*?value: \$\{\{ jobs\.ffmpeg\.outputs\.artifact_name \}\}/);
  assert.match(workflow, /ffmpeg_build_key:[\s\S]*?value: \$\{\{ jobs\.ffmpeg\.outputs\.build_key \}\}/);
  const desktop = workflowJob(release, 'desktop');
  assert.match(desktop, /needs: \[preflight, checks\]/);
  assert.match(desktop, /name: Download verified Linux media toolchain\r?\n\s+if: runner\.os == 'Linux'\r?\n\s+uses: actions\/download-artifact@[a-f0-9]{40}/);
  assert.match(desktop, /name: \$\{\{ needs\.checks\.outputs\.ffmpeg_artifact \}\}/);
  assert.match(desktop, /MIOON_FFMPEG_BUILD_KEY: \$\{\{ needs\.checks\.outputs\.ffmpeg_build_key \}\}/);
  assert.match(desktop, /name: Verify and activate Linux media toolchain\r?\n\s+if: runner\.os == 'Linux'[\s\S]*?run: node \.github\/scripts\/ffmpeg-toolchain\.ts activate/);
  assert.doesNotMatch(release, /install-ffmpeg\.ts|ffmpeg-toolchain\.ts build|checks-ffmpeg-.*(?:run_id|run_attempt)/);
  const gate = workflowJob(ci, 'ci');
  assert.match(gate, /name: CI/); assert.match(gate, /if: always\(\)/); assert.match(gate, /needs: checks/);
  assert.match(gate, /CHECKS_RESULT: \$\{\{ needs\.checks\.result \}\}/);
  assert.match(gate, /test "\$CHECKS_RESULT" = success/);
  assert.match(workflow, /permissions:\r?\n  contents: read/);
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
