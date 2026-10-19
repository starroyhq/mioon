import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp, mkdir, chmod, symlink, writeFile, readFile, readdir, lstat, realpath, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const posix = {skip: process.platform === 'win32' ? 'POSIX fixture; Windows private storage is explicitly unavailable' : false};
async function fixture(t: unknown) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-demo-private-'));
  (t as {after(callback: ()=>void): void}).after(() => rm(root, {recursive: true, force: true}));
  const marker = path.join(root, 'backend-spawned'), guard = path.join(root, 'guard.mjs');
  // Trusted test-only instrumentation proves rejection precedes backend spawn.
  // No production env/hook or substitute business operation is introduced.
  await writeFile(guard, `import cp from 'node:child_process'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; cp.spawn=()=>{fs.writeFileSync(${JSON.stringify(marker)},'unexpected backend spawn');throw Error('unexpected backend spawn');}; syncBuiltinESMExports();\n`, {mode: 0o600});
  return {root, marker, run(target: string) {
    const result = spawnSync(process.execPath, ['--import', guard, 'scripts/create-timeline-demo.ts'], {
      cwd: repo, encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
      env: {PATH: process.env.PATH || '', HOME: root, TMPDIR: root, LANG: 'C.UTF-8', MIOON_V2_DEMO_DIR: target, MIOON_ENABLE_LIVE_PROVIDER: '0'},
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /STORAGE_PRIVATE_REQUIRED/);
    assert.ok(!result.stderr.includes(target), 'storage diagnostic does not echo the private target');
    return result;
  }};
}

test('timeline demo refuses a broad existing root without repairing it or spawning a backend', posix, async t => {
  const f = await fixture(t), target = path.join(f.root, 'old-demo');
  await mkdir(target, {mode: 0o755}); await chmod(target, 0o755);
  await writeFile(path.join(target, 'preserve.txt'), 'synthetic original bytes', {mode: 0o600});
  f.run(target);
  assert.equal((await lstat(target)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(target), ['preserve.txt']);
  assert.equal(await readFile(path.join(target, 'preserve.txt'), 'utf8'), 'synthetic original bytes');
  await assert.rejects(lstat(f.marker), {code: 'ENOENT'});
});

test('timeline demo rejects an alias before creating nonexistent descendants outside the selected path', posix, async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'), alias = path.join(f.root, 'alias');
  await mkdir(outside, {mode: 0o700}); await symlink(outside, alias);
  f.run(path.join(alias, 'new', 'workspace'));
  assert.deepEqual(await readdir(outside), []);
  assert.equal((await lstat(outside)).mode & 0o777, 0o700);
  await assert.rejects(lstat(f.marker), {code: 'ENOENT'});
});
