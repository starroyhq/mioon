import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, realpath, rename, rm, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {discoverTests, toolingEnvironment} from '../scripts/lib/local-tooling.ts';
import {EXCLUSIVE_TEST_FILES, parseShardArguments, parseTestTimings, partitionFullTests, shardCommand, shardCommands, shardReport, verifyFullPartition, TIMINGS_FILE} from '../.github/scripts/test-shard.ts';
import {mergeTestTimings} from '../.github/scripts/test-timings.ts';

const sourceSha = 'a'.repeat(40);
const files = Array.from({length: 784}, (_, index) => `tests/file-${String(index).padStart(4, '0')}.test.${index % 2 ? 'mjs' : 'ts'}`);
for (const count of [4, 8]) {
  test(`${count} shards without recorded timings include every authoritative full test exactly once, round-robin by name`, () => {
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
  const timingsText = await readFile(path.join(root, TIMINGS_FILE), 'utf8'), timings = parseTestTimings(timingsText);
  verifyFullPartition(full, indexes.map(index => shardReport(full, {index, count}, sourceSha, timings, timingsText).files));
  assert.match(quality, /node \.github\/scripts\/test-shard\.ts [^\r\n]*--concurrency=3(?=\s|$)/, 'each 4-vCPU shard runs three isolated files at a time');
  for (const name of ['timings', 'timings-alone']) assert.match(quality, new RegExp(`artifacts/checks-linux-\\$\\{\\{ matrix\\.shard \\}\\}/${name}\\.json`), 'shards upload the timings that refresh the table');
  const exclusive = full.filter(file => EXCLUSIVE_TEST_FILES.includes(file));
  assert.deepEqual(exclusive, [...EXCLUSIVE_TEST_FILES], 'every file run alone must still exist in the full catalog');
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
test('CLI accepts only a bounded explicit index, count and per-shard concurrency', () => {
  assert.deepEqual(parseShardArguments(['--index=0', '--count=4']), {index: 0, count: 4, concurrency: 1});
  assert.deepEqual(parseShardArguments(['--count=4', '--index=3']), {index: 3, count: 4, concurrency: 1});
  assert.deepEqual(parseShardArguments(['--count=8', '--index=7', '--concurrency=3']), {index: 7, count: 8, concurrency: 3});
  for (const args of [['--index=0', '--count=4', '--concurrency=0'], ['--index=0', '--count=4', '--concurrency=5'], ['--index=0', '--count=4', '--concurrency=2', '--concurrency=3']]) {
    assert.throws(() => parseShardArguments(args), /INVALID_SHARD_(ARGUMENTS|CONCURRENCY)/);
  }
  for (const args of [[], ['--index=0'], ['--count=4'], ['--index=0', '--count=4', '--index=1'], ['--index=0', '--count=4', '--output=/tmp/private'], ['--index=-1', '--count=4'], ['--index=1.5', '--count=4'], ['--index=01', '--count=4'], ['--index=4', '--count=4'], ['--index=0', '--count=0'], ['--index=0', '--count=33'], ['--index=99999999999999999', '--count=4']]) {
    assert.throws(() => parseShardArguments(args), /INVALID_SHARD_(ARGUMENTS|INDEX|COUNT)/);
  }
});
test('report rejects invalid indexes and source identities', () => {
  for (const index of [-1, 4, 1.5, NaN]) assert.throws(() => shardReport(files, {index, count: 4}, sourceSha), /INVALID_SHARD_INDEX/);
  for (const sha of ['', 'main', 'b'.repeat(39), 'z'.repeat(40), 'a'.repeat(40) + '\n']) assert.throws(() => shardReport(files, {index: 0, count: 4}, sha), /INVALID_SOURCE_SHA/);
});
test('test launcher preserves the full lane and process isolation, with bounded concurrency and timings', () => {
  const root = path.resolve('synthetic root'), executable = path.resolve('synthetic-node');
  const selected = ['tests/b.test.ts', 'tests/a.test.mjs'];
  assert.deepEqual(shardCommand(root, selected, executable), {command: executable, cwd: root, args: [path.join(root, 'scripts/tooling.ts'), 'test', '--suite=full', '--concurrency=1', '--reporter=tap', '--file=a.test.mjs', '--file=b.test.ts']});
  assert.deepEqual(shardCommand(root, selected, executable, {concurrency: 3, timings: 'artifacts/checks-linux-2/timings.json'}).args,
    [path.join(root, 'scripts/tooling.ts'), 'test', '--suite=full', '--concurrency=3', '--reporter=tap', '--timings=artifacts/checks-linux-2/timings.json', '--file=a.test.mjs', '--file=b.test.ts']);
  const environment = toolingEnvironment({PATH: '/usr/bin', HOME: '/owned', NODE_OPTIONS: '--import=private-loader', NODE_PATH: '/private-modules', GH_TOKEN: 'private-gh-token', APPLE_API_KEY: 'private-key', MIOON_FFMPEG_PATH: '/owned/ffmpeg', MIOON_FFPROBE_PATH: '/owned/ffprobe'}, {mediaPaths: true});
  assert.equal(environment.NODE_OPTIONS, undefined); assert.equal(environment.NODE_PATH, undefined); assert.equal(environment.GH_TOKEN, undefined); assert.equal(environment.APPLE_API_KEY, undefined);
  assert.equal(environment.MIOON_FFMPEG_PATH, '/owned/ffmpeg'); assert.equal(environment.MIOON_FFPROBE_PATH, '/owned/ffprobe'); assert.equal(environment.MIOON_ENABLE_LIVE_PROVIDER, '0');
});

const table = (files: Record<string, unknown>) => JSON.stringify({schema: 1, unit: 'seconds', files});
test('timed shards keep every test exactly once and finish within one file of an even split', () => {
  // Deterministic uneven weights, with a few files far heavier than the rest.
  const weights = new Map(files.map((file, index) => [file, index % 97 === 0 ? 300 : (index * 37) % 61 + 1]));
  const total = [...weights.values()].reduce((sum, value) => sum + value, 0), heaviest = Math.max(...weights.values());
  for (const count of [4, 8]) {
    const shards = partitionFullTests(files, count, weights);
    verifyFullPartition(files, shards);
    assert.deepEqual(partitionFullTests([...files].reverse(), count, weights), shards, 'catalog order cannot change the partition');
    for (const shard of shards) {
      assert.deepEqual(shard, [...shard].sort());
      assert.ok(shard.reduce((sum, file) => sum + weights.get(file)!, 0) <= total / count + heaviest);
    }
  }
});
test('files missing from the timing table weigh the recorded median and stale entries are ignored', () => {
  const full = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts', 'tests/new.test.ts'];
  const timings = new Map([['tests/a.test.ts', 10], ['tests/b.test.ts', 1], ['tests/c.test.ts', 2], ['tests/removed.test.ts', 999]]);
  // a=10 alone; b and c with the median-weighted new file (2) on the other shard.
  assert.deepEqual(partitionFullTests(full, 2, timings), [['tests/a.test.ts'], ['tests/b.test.ts', 'tests/c.test.ts', 'tests/new.test.ts']]);
  const report = shardReport(full, {index: 1, count: 2}, sourceSha, timings, 'recorded');
  assert.equal(report.schema, 2); assert.equal(report.estimatedSeconds, 5); assert.match(report.timingsSha256, /^[a-f0-9]{64}$/);
});
test('the timing table must be a bounded per-file map', () => {
  assert.deepEqual([...parseTestTimings(table({'tests/a.test.ts': 1.5, 'tests/b.test.mjs': 0}))], [['tests/a.test.ts', 1.5], ['tests/b.test.mjs', 0]]);
  for (const text of ['not json', JSON.stringify({schema: 2, files: {}}), JSON.stringify({schema: 1, files: []}), JSON.stringify({schema: 1}),
    table({'tests/../a.test.ts': 1}), table({'a.test.ts': 1}), table({'tests/a.test.ts': -1}), table({'tests/a.test.ts': 'slow'}), table({'tests/a.test.ts': 3601})]) {
    assert.throws(() => parseTestTimings(text), /INVALID_TEST_TIMINGS/);
  }
});
test('the committed timing table parses and covers most of the full catalog', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const timings = parseTestTimings(await readFile(path.join(root, TIMINGS_FILE), 'utf8'));
  const full = await discoverTests(root, {suite: 'full', platform: 'linux'});
  assert.ok(full.filter(file => timings.has(file)).length >= full.length * 0.9, 'refresh the table with .github/scripts/test-timings.ts');
});
test('a CI run\'s shard timings refresh the table without losing unmeasured or keeping deleted files', () => {
  const previous = table({'tests/a.test.ts': 5, 'tests/b.test.ts': 6, 'tests/gone.test.ts': 7});
  const merged = mergeTestTimings(previous, [table({'tests/a.test.ts': 4}), table({'tests/c.test.mjs': 2.5})], ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.mjs']);
  assert.equal(merged, `${JSON.stringify({schema: 1, unit: 'seconds', files: {'tests/a.test.ts': 4, 'tests/b.test.ts': 6, 'tests/c.test.mjs': 2.5}}, null, 1)}\n`);
  assert.throws(() => mergeTestTimings(table({}), [table({'tests/gone.test.ts': 1})], ['tests/a.test.ts']), /NO_TEST_TIMINGS/);
  assert.throws(() => mergeTestTimings(previous, ['{broken'], ['tests/a.test.ts']), /INVALID_TEST_TIMINGS/);
});
test('exclusive files run alone after the shared ones and weigh their full time', () => {
  const [alone] = EXCLUSIVE_TEST_FILES;
  const full = [alone!, 'tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'];
  const timings = new Map([[alone!, 30], ['tests/a.test.ts', 30], ['tests/b.test.ts', 30], ['tests/c.test.ts', 30]]);
  // Three at a time, a shared file costs 10 s of wall time but the exclusive one all 30 s.
  assert.deepEqual(partitionFullTests(full, 2, timings, 3), [[alone!].sort(), ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts']]);
  const report = shardReport(full, {index: 0, count: 2, concurrency: 3}, sourceSha, timings, 'recorded');
  assert.deepEqual(report.exclusiveFiles, [alone!]); assert.equal(report.estimatedSeconds, 30);
  const root = path.resolve('synthetic root'), executable = path.resolve('synthetic-node');
  const commands = shardCommands(root, {shardIndex: 4, files: [alone!, 'tests/a.test.ts'].sort(), exclusiveFiles: [alone!]}, 3, executable);
  assert.deepEqual(commands.map(command => command.args.slice(3)), [
    ['--concurrency=3', '--reporter=tap', '--timings=artifacts/checks-linux-4/timings.json', '--file=a.test.ts'],
    ['--concurrency=1', '--reporter=tap', '--timings=artifacts/checks-linux-4/timings-alone.json', `--file=${alone!.slice('tests/'.length)}`],
  ]);
  assert.equal(shardCommands(root, {shardIndex: 0, files: ['tests/a.test.ts'], exclusiveFiles: []}, 3, executable).length, 1);
  assert.deepEqual([...EXCLUSIVE_TEST_FILES], [...new Set(EXCLUSIVE_TEST_FILES)].sort());
});
