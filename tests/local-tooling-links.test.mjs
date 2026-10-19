// Linux/full-lane ownership tests. Creating native Windows symlinks is not a
// prerequisite of the reviewed portable lane; there is no skip-as-pass here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, mkdir, writeFile, symlink, chmod, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {installedPackages, inspectPackageManager, toolingEnvironment} from '../scripts/lib/local-tooling.ts';

const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-tooling-links-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo'), outside = path.join(root, 'outside');
  await mkdir(path.join(repo, 'apps/web'), {recursive: true}); await mkdir(outside);
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({packageManager: 'pnpm@11.25.0', devDependencies: {esbuild: '0.27.7', electron: '44.7.0'}}));
  await writeFile(path.join(repo, 'apps/web/package.json'), JSON.stringify({devDependencies: {vite: '7.3.1'}}));
  return {repo, outside};
}
test('tooling refuses a repository node_modules root redirected outside the repository', async t => {
  const {repo, outside} = await fixture(t);
  await symlink(outside, path.join(repo, 'node_modules'), 'dir');
  await assert.rejects(installedPackages(repo), {code: 'LOCAL_DEPENDENCY_INVALID'});
});
test('tooling refuses package metadata resolving outside canonical node_modules', async t => {
  const {repo, outside} = await fixture(t); await mkdir(path.join(repo, 'node_modules'));
  await writeFile(path.join(outside, 'package.json'), JSON.stringify({name: 'vite', version: '7.3.1', bin: {vite: 'bin/vite.js'}}));
  await symlink(outside, path.join(repo, 'node_modules/vite'), 'dir');
  await assert.rejects(installedPackages(repo), {code: 'LOCAL_DEPENDENCY_INVALID'});
});
test('tooling refuses an entrypoint symlink outside an otherwise valid local package', async t => {
  const {repo, outside} = await fixture(t); const vite = path.join(repo, 'node_modules/vite');
  await mkdir(path.join(vite, 'bin'), {recursive: true});
  await writeFile(path.join(vite, 'package.json'), JSON.stringify({name: 'vite', version: '7.3.1', bin: {vite: 'bin/vite.js'}}));
  await writeFile(path.join(outside, 'entry.js'), 'throw Error("must not execute");');
  await symlink(path.join(outside, 'entry.js'), path.join(vite, 'bin/vite.js'), 'file');
  await assert.rejects(installedPackages(repo), {code: 'LOCAL_DEPENDENCY_INVALID'});
});

async function managerFixture(t) {
  const {repo, outside} = await fixture(t);
  const manager = path.join(outside, 'pnpm'), bin = path.join(outside, 'bin');
  await mkdir(path.join(manager, 'bin'), {recursive: true}); await mkdir(bin);
  await writeFile(path.join(manager, 'package.json'), JSON.stringify({name: 'pnpm', version: '10.8.1', bin: {pnpm: 'bin/pnpm.cjs'}}));
  const entry = path.join(manager, 'bin/pnpm.cjs');
  await writeFile(entry, '#!/usr/bin/env node\nthrow Error("must not execute");\n', {mode: 0o755});
  await symlink(entry, path.join(bin, 'pnpm'));
  return {repo, outside, manager, entry, bin, options: {env: {PATH: bin}, platform: 'linux'}};
}
test('doctor reads a linked pnpm package version without admitting it as a build dependency', async t => {
  const {repo, options} = await managerFixture(t);
  const result = await inspectPackageManager(repo, options);
  assert.equal(result.status, 'mismatch'); assert.equal(result.observedVersion, '10.8.1');
  await assert.rejects(installedPackages(repo), {code: 'LOCAL_DEPENDENCY_MISSING'});
});
test('pnpm metadata or declared entry escaping its package remains unverified', async t => {
  const {repo, outside, manager, options} = await managerFixture(t);
  const metadata = path.join(manager, 'package.json');
  await rm(metadata);
  await writeFile(path.join(outside, 'package.json'), JSON.stringify({name: 'pnpm', version: '11.25.0', bin: {pnpm: 'bin/pnpm.cjs'}}));
  await symlink(path.join(outside, 'package.json'), metadata);
  assert.equal((await inspectPackageManager(repo, options)).status, 'unverified');
  await rm(metadata);
  await writeFile(metadata, JSON.stringify({name: 'pnpm', version: '11.25.0', bin: {pnpm: 'bin/escaped.cjs'}}));
  await writeFile(path.join(outside, 'escaped.cjs'), 'throw Error("must not execute");');
  await symlink(path.join(outside, 'escaped.cjs'), path.join(manager, 'bin/escaped.cjs'));
  assert.equal((await inspectPackageManager(repo, options)).status, 'unverified');
});
test('non-executable pnpm candidates are not reported as installed commands', async t => {
  const {repo, entry, options} = await managerFixture(t);
  await chmod(entry, 0o644);
  const result = await inspectPackageManager(repo, options);
  assert.equal(result.status, 'missing'); assert.equal(result.observedVersion, null);
});
test('a FIFO masquerading as pnpm package metadata cannot hang doctor', async t => {
  const {repo, manager, options} = await managerFixture(t);
  const metadata = path.join(manager, 'package.json');
  await rm(metadata);
  // Native POSIX-only fixture. The portable manifest does not include this file.
  await exec('/usr/bin/mkfifo', [metadata], {env: toolingEnvironment(), timeout: 5000});
  const moduleUrl = new URL('../scripts/lib/local-tooling.ts', import.meta.url).href;
  const script = `import {inspectPackageManager} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await inspectPackageManager(${JSON.stringify(repo)}, ${JSON.stringify(options)})));`;
  // A regression is killed in its own Node process, so the test runner cannot
  // hang on an outstanding FIFO open or leave a reader attached to the fixture.
  const {stdout} = await exec(process.execPath, ['--input-type=module', '-e', script],
    {env: toolingEnvironment(), timeout: 5000, killSignal: 'SIGKILL'});
  assert.equal(JSON.parse(stdout).status, 'unverified');
});
