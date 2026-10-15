import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installedTypeScript, toolingEnvironment} from '../scripts/lib/local-tooling.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const configurationName = 'tests/typecheck/tsconfig.foundation.json';
const consumers = ['media-streaming-runtime.consumer.mts', 'timeline-audio-preview-coordinator.consumer.mts'];
const sources = [
  'packages/business/src/media-streaming-runtime.ts',
  'packages/business/src/timeline-audio-preview-coordinator.ts',
  'packages/business/src/timeline-audio-preview.ts',
  'packages/business/src/timeline-audio-preview-decoder.ts',
  'packages/business/src/timeline-audio-continuous.ts',
  'packages/business/src/timeline-audio-continuous-decoder.ts',
  'packages/business/src/timeline-volume-envelope-source.ts',
  'packages/contracts/src/timeline-volume-envelope-processing.ts',
  'packages/contracts/src/timeline-volume-envelope.d.mts',
  'packages/contracts/src/timeline-audio-preview.ts',
  'packages/contracts/src/timeline-audio-continuous.ts',
  'packages/contracts/src/timeline-segments.ts',
];

async function snapshot(directory) {
  const files = {};
  for (const item of await readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) {
      for (const [name, digest] of Object.entries(await snapshot(file))) files[path.join(item.name, name)] = digest;
    } else {
      assert.ok(item.isFile(), 'The compiler fixture must contain only copied regular files');
      files[item.name] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }
  return files;
}

async function compile(directory, compiler) {
  const before = await snapshot(directory);
  const result = spawnSync(process.execPath, [compiler.entry, '--project', path.join(directory, configurationName), '--noEmit', '--pretty', 'false'], {
    cwd: directory, env: toolingEnvironment(), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    shell: false, windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message); assert.equal(result.signal, null);
  assert.deepEqual(await snapshot(directory), before, 'The strict compiler must not emit or modify fixture files');
  return result;
}

test('strict real compiler rejects unsuppressed runner and coordinator implementation errors and recovers without emit', {timeout: 120000}, async t => {
  const compiler = await installedTypeScript(repository);
  const evidence = path.join(await realpath(repository), 'evidence');
  await mkdir(evidence, {recursive: true, mode: 0o700});
  const directory = await mkdtemp(path.join(evidence, 'continuous-audio-typecheck-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  for (const name of [...sources, 'packages/contracts/src/timeline-volume-envelope.mjs', ...consumers.map(name => `tests/typecheck/${name}`), 'package.json', 'packages/contracts/package.json']) {
    const destination = path.join(directory, name);
    await mkdir(path.dirname(destination), {recursive: true});
    await writeFile(destination, await readFile(path.join(repository, name)));
  }
  // Preserve the formal project's strict options and real declarations. Only
  // its root files are narrowed to this isolated copy and its genuine consumers.
  const formal = JSON.parse(await readFile(path.join(repository, configurationName), 'utf8'));
  await writeFile(path.join(directory, configurationName), JSON.stringify({compilerOptions: formal.compilerOptions,
    files: [...sources.map(name => `../../${name}`), ...consumers.map(name => `./${name}`)]}));
  // The public package route must resolve to copied source as well. Zod is its
  // real installed dependency; no ambient declarations or resolver aliases are
  // supplied to hide missing or incompatible types.
  await cp(path.join(directory, 'packages/contracts'), path.join(directory, 'node_modules/@mioon/contracts'), {recursive: true});
  await cp(await realpath(path.join(repository, 'packages/contracts/node_modules/zod')), path.join(directory, 'node_modules/zod'), {recursive: true});
  const initial = await compile(directory, compiler);
  assert.equal(initial.status, 0, initial.stdout + initial.stderr);

  for (const mutation of [
    {name: 'packages/business/src/media-streaming-runtime.ts', before: 'resolve({stdoutBytes});', after: 'resolve({stdoutBytes: "invalid"});',
      diagnostic: /media-streaming-runtime\.ts\(\d+,\d+\): error TS2322:/},
    {name: 'packages/business/src/timeline-audio-preview-coordinator.ts', before: 'await Promise.all([legacy.drain(), continuous.drain()]);',
      after: 'return "invalid";', diagnostic: /timeline-audio-preview-coordinator\.ts\(\d+,\d+\): error TS2322:/},
  ]) {
    const file = path.join(directory, mutation.name), source = await readFile(file, 'utf8');
    assert.equal(source.split(mutation.before).length, 2, 'Mutation must target exactly one real implementation statement');
    await writeFile(file, source.replace(mutation.before, mutation.after));
    const rejected = await compile(directory, compiler);
    assert.equal(rejected.status, 2, rejected.stdout + rejected.stderr);
    assert.match(rejected.stdout + rejected.stderr, mutation.diagnostic, 'The real implementation must receive the type error');
    await writeFile(file, source);
    const recovered = await compile(directory, compiler);
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  }
});
