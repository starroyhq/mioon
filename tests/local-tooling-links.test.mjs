// Linux/full-lane ownership tests. Creating native Windows symlinks is not a
// prerequisite of the reviewed portable lane; there is no skip-as-pass here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {installedPackages} from '../scripts/lib/local-tooling.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-tooling-links-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo'), outside = path.join(root, 'outside');
  await mkdir(path.join(repo, 'apps/web'), {recursive: true}); await mkdir(outside);
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({devDependencies: {esbuild: '0.27.7', electron: '44.7.0'}}));
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
