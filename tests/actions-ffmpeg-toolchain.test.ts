import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, truncate, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {activateToolchain, stageToolchain, toolchainCacheKey, toolchainProfile} from '../.github/scripts/ffmpeg-toolchain.ts';
import {FFMPEG_SOURCE} from '../.github/scripts/install-ffmpeg.ts';
import type {command} from '../.github/scripts/media-environment.ts';

const profile = 'a'.repeat(64), operatingSystem = 'ID=ubuntu\nVERSION_ID="22.04"\n';
const buildKey = toolchainCacheKey(profile, 'gcc=11\nlibass9=0.15\n', operatingSystem);
async function fixture(t: TestContext) {
  const runnerTemp = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-ffmpeg-toolchain-test-'));
  t.after(() => rm(runnerTemp, {recursive: true, force: true}));
  const original = path.join(runnerTemp, 'random-build/install/bin'); await mkdir(original, {recursive: true});
  const installation = {ffmpeg: path.join(original, 'ffmpeg'), ffprobe: path.join(original, 'ffprobe')};
  for (const [name, file] of Object.entries(installation)) await writeFile(file, `synthetic ${name} executable bytes`, {mode: 0o700});
  const options = {runnerTemp, buildKey, githubPath: path.join(runnerTemp, 'github-path'), githubEnv: path.join(runnerTemp, 'github-env'), githubSummary: path.join(runnerTemp, 'github-summary')};
  const directory = path.join(runnerTemp, 'mioon-ffmpeg-toolchain');
  const calls: string[] = [];
  const execute: typeof command = async (file, args) => {
    calls.push(path.basename(file)); assert.deepEqual(args, ['-version']);
    if (process.platform !== 'win32') assert.equal((await lstat(file)).mode & 0o777, 0o700);
    return `${path.basename(file)} version ${FFMPEG_SOURCE.version} synthetic\n`;
  };
  return {runnerTemp, installation, options, directory, calls, execute};
}
async function assertNoExports(options: {githubPath: string; githubEnv: string; githubSummary: string}): Promise<void> {
  for (const file of [options.githubPath, options.githubEnv, options.githubSummary]) await assert.rejects(readFile(file), {code: 'ENOENT'});
}
test('cache identity binds source/profile, installed library/compiler versions and Ubuntu release', () => {
  assert.equal(toolchainCacheKey(profile, 'libass9=0.15\ngcc=11\n', operatingSystem), buildKey);
  for (const changed of [toolchainCacheKey('b'.repeat(64), 'gcc=11\nlibass9=0.15', operatingSystem), toolchainCacheKey(profile, 'gcc=12\nlibass9=0.15', operatingSystem), toolchainCacheKey(profile, 'gcc=11\nlibass9=0.16', operatingSystem)]) assert.notEqual(changed, buildKey);
  for (const os of ['ID=debian\nVERSION_ID="22.04"', 'ID=ubuntu\nVERSION_ID="24.04"', 'ID=ubuntu\nVERSION_ID="22.04-extra"']) assert.throws(() => toolchainCacheKey(profile, 'gcc=11', os), /IDENTITY_INVALID/);
  assert.throws(() => toolchainCacheKey('invalid', 'gcc=11', operatingSystem), /IDENTITY_INVALID/);
  assert.throws(() => toolchainCacheKey(profile, '', operatingSystem), /IDENTITY_INVALID/);
});
test('the real profile hashes the pinned installer, transport, helper and media probes', async () => {
  const first = await toolchainProfile(); assert.match(first, /^[a-f0-9]{64}$/); assert.equal(await toolchainProfile(), first);
});
test('one staged toolchain survives removal of random build paths and artifact permission loss', async t => {
  const f = await fixture(t);
  assert.equal(await stageToolchain(f.options, f.installation, profile), f.directory);
  assert.deepEqual((await readdir(f.directory)).sort(), ['ffmpeg', 'ffprobe', 'manifest.json']);
  await rm(path.join(f.runnerTemp, 'random-build'), {recursive: true});
  for (const name of ['ffmpeg', 'ffprobe']) await chmod(path.join(f.directory, name), 0o644);
  const tools = await activateToolchain(f.options, profile, f.execute);
  assert.deepEqual(f.calls, ['ffmpeg', 'ffprobe']);
  assert.deepEqual(tools, {ffmpeg: path.join(f.directory, 'ffmpeg'), ffprobe: path.join(f.directory, 'ffprobe')});
  assert.equal(await readFile(f.options.githubEnv, 'utf8'), `MIOON_FFMPEG_PATH=${tools.ffmpeg}\nMIOON_FFPROBE_PATH=${tools.ffprobe}\n`);
  assert.equal(await readFile(f.options.githubPath, 'utf8'), `${f.directory}\n`);
  assert.match(await readFile(f.options.githubSummary, 'utf8'), /required media probes run separately/);
});
test('all binary hashes are checked before either tool executes or any path is exported', async t => {
  for (const name of ['ffmpeg', 'ffprobe']) {
    const f = await fixture(t); await stageToolchain(f.options, f.installation, profile);
    const file = path.join(f.directory, name), original = await readFile(file);
    original[0] = original[0]! ^ 1; await writeFile(file, original);
    await assert.rejects(activateToolchain(f.options, profile, f.execute), /SHA256_MISMATCH/);
    assert.deepEqual(f.calls, []); await assertNoExports(f.options);
    if (process.platform !== 'win32') assert.equal((await lstat(path.join(f.directory, 'ffmpeg'))).mode & 0o111, 0);
  }
});
test('foreign build keys, source pins, profiles, versions or file inventories cannot activate a cache', async t => {
  const changes = [
    {buildKey: buildKey.replace(/[a-f0-9]$/, value => value === '0' ? '1' : '0')}, {sourceSha256: 'b'.repeat(64)}, {profileSha256: 'b'.repeat(64)}, {schema: 2}, {version: '4.4.2'}, {files: {}}, {unreviewed: true}
  ];
  for (const change of changes) {
    const f = await fixture(t); await stageToolchain(f.options, f.installation, profile);
    const file = path.join(f.directory, 'manifest.json');
    await writeFile(file, JSON.stringify({...JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>, ...change}));
    await assert.rejects(activateToolchain(f.options, profile, f.execute), /MANIFEST_INVALID/);
    assert.deepEqual(f.calls, []); await assertNoExports(f.options);
  }
});
test('partial, malformed or oversized manifests and extra files fail closed', async t => {
  for (const contents of ['', '{', 'x'.repeat(4097)]) {
    const f = await fixture(t); await stageToolchain(f.options, f.installation, profile);
    await writeFile(path.join(f.directory, 'manifest.json'), contents);
    await assert.rejects(activateToolchain(f.options, profile, f.execute), /FILE_INVALID|MANIFEST_INVALID/);
    assert.deepEqual(f.calls, []); await assertNoExports(f.options);
  }
  const f = await fixture(t); await stageToolchain(f.options, f.installation, profile);
  await writeFile(path.join(f.directory, 'unexpected'), 'foreign bytes');
  await assert.rejects(activateToolchain(f.options, profile, f.execute), /DIRECTORY_INVALID/); assert.deepEqual(f.calls, []);
});
test('a valid manifest never substitutes for exact executable versions or successful startup', async t => {
  for (const execute of [async () => 'ffmpeg version 4.4.2 old\n', async () => {throw new Error('synthetic runtime library missing');}]) {
    const f = await fixture(t); await stageToolchain(f.options, f.installation, profile);
    await assert.rejects(activateToolchain(f.options, profile, execute), /VERSION_MISMATCH|runtime library missing/);
    await assertNoExports(f.options);
  }
});
test('empty or oversized binary files are rejected before hashing or execution', async t => {
  for (const size of [0, 128 * 1024 * 1024 + 1]) {
    const f = await fixture(t); await stageToolchain(f.options, f.installation, profile);
    await truncate(path.join(f.directory, 'ffprobe'), size);
    await assert.rejects(activateToolchain(f.options, profile, f.execute), /FILE_INVALID/); assert.deepEqual(f.calls, []);
  }
});
test('symlinked bundles, binary and manifest paths cannot be restored', {skip: process.platform === 'win32'}, async t => {
  for (const name of ['ffmpeg', 'ffprobe', 'manifest.json', 'directory']) {
    const f = await fixture(t); await stageToolchain(f.options, f.installation, profile);
    if (name === 'directory') {
      await rm(f.directory, {recursive: true}); await symlink(path.dirname(f.installation.ffmpeg), f.directory);
    } else {
      const file = path.join(f.directory, name); await rm(file); await symlink(f.installation.ffmpeg, file);
    }
    await assert.rejects(activateToolchain(f.options, profile, f.execute), /FILE_INVALID|DIRECTORY_INVALID/);
    assert.deepEqual(f.calls, []); await assertNoExports(f.options);
  }
});
test('invalid export paths and keys are refused and preexisting bundles are never overwritten', async t => {
  const f = await fixture(t);
  for (const key of ['', 'main', `${buildKey}\n`, buildKey + '/extra']) await assert.rejects(stageToolchain({...f.options, buildKey: key}, f.installation, profile), /BUILD_KEY_INVALID/);
  for (const runnerTemp of ['relative', f.runnerTemp + '\n']) await assert.rejects(stageToolchain({...f.options, runnerTemp}, f.installation, profile), /TEMP_INVALID/);
  await mkdir(f.directory); await writeFile(path.join(f.directory, 'user-work'), 'preserved');
  await assert.rejects(stageToolchain(f.options, f.installation, profile), {code: 'EEXIST'});
  assert.equal(await readFile(path.join(f.directory, 'user-work'), 'utf8'), 'preserved');
});
