import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {fileDuration} from '../scripts/lib/test-timing-reporter.ts';
import {parseTestTimings} from '../.github/scripts/test-shard.ts';

const execute = promisify(execFile);
const reporter = fileURLToPath(new URL('../scripts/lib/test-timing-reporter.ts', import.meta.url));

test('only the file-level completion of a test file counts, in seconds and repository-relative', () => {
  const cwd = path.resolve('repo'), file = path.join(cwd, 'tests', 'a.test.ts');
  const event = (data: Record<string, unknown>, type = 'test:complete') => ({type, data: {nesting: 0, file, name: 'tests/a.test.ts', details: {duration_ms: 1234.5}, ...data}});
  assert.deepEqual(fileDuration(event({}), cwd), ['tests/a.test.ts', 1.23]);
  assert.equal(fileDuration(event({name: 'a test inside the file'}), cwd), null);
  assert.equal(fileDuration(event({nesting: 1}), cwd), null);
  assert.equal(fileDuration(event({}, 'test:pass'), cwd), null);
  for (const duration of [undefined, -1, Number.NaN, 'slow']) assert.equal(fileDuration(event({details: {duration_ms: duration}}), cwd), null);
  assert.equal(fileDuration({type: 'test:complete'}, cwd), null);
});

test('a real test run writes one entry per file, including module setup before its tests', async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-test-timings-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'tests'));
  await writeFile(path.join(root, 'tests', 'slow.test.mjs'), "import test from 'node:test';\nawait new Promise(resolve => setTimeout(resolve, 250));\ntest('one', () => {});\ntest('two', async t => { await t.test('nested', () => {}); });\n");
  await writeFile(path.join(root, 'tests', 'quick.test.mjs'), "import test from 'node:test';\ntest('quick', () => {});\n");
  const destination = path.join(root, 'timings.json');
  await execute(process.execPath, ['--test', '--test-reporter=tap', '--test-reporter-destination=stdout', `--test-reporter=${reporter}`, `--test-reporter-destination=${destination}`,
    // A nested runner that inherits this test's context reports to it instead of to the chosen reporters.
    '--test-concurrency=2', 'tests/slow.test.mjs', 'tests/quick.test.mjs'], {cwd: root, timeout: 60000, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'))});
  const timings = parseTestTimings(await readFile(destination, 'utf8'));
  assert.deepEqual([...timings.keys()], ['tests/quick.test.mjs', 'tests/slow.test.mjs']);
  assert.ok(timings.get('tests/slow.test.mjs')! >= 0.25, 'the file time includes its module setup');
});
