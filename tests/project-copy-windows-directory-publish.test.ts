import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {publishProjectCopyDirectory} from '../packages/business/src/project-file/backup.ts';

const fixture = async (t: test.TestContext): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-copy-publish-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
};
test('Windows publication removes the empty target placeholder before renaming the staging folder', async t => {
  const root = await fixture(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  await mkdir(staging); await mkdir(target); await writeFile(path.join(staging, 'Film.mioon'), 'project');
  publishProjectCopyDirectory(staging, target, 'win32');
  assert.deepEqual(await readdir(target), ['Film.mioon']);
});
test('a non-empty target is rejected on Windows without moving the staging folder', async t => {
  const root = await fixture(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  await mkdir(staging); await mkdir(target); await writeFile(path.join(target, 'unexpected'), 'x');
  assert.throws(() => publishProjectCopyDirectory(staging, target, 'win32'), /not empty/u);
  assert.deepEqual(await readdir(target), ['unexpected']);
  assert.deepEqual(await readdir(staging), []);
});
test('POSIX publication keeps the native rename-over-empty-directory behavior', async t => {
  const root = await fixture(t), staging = path.join(root, 'staging'), target = path.join(root, 'target');
  await mkdir(staging); await mkdir(target); await writeFile(path.join(staging, 'Film.mioon'), 'project');
  publishProjectCopyDirectory(staging, target, 'darwin');
  assert.deepEqual(await readdir(target), ['Film.mioon']);
});
