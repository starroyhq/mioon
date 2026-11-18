import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {testEnv} from './helpers/test-env.ts';
import {bottleShaFromInfo, sha256File, verifyBottleArchive, writeToolchainEvidence} from '../.github/scripts/macos-media-toolchain.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = 'a'.repeat(64);
const probe = {
  ok: true, platform: 'darwin',
  tools: {ffmpeg: '', ffprobe: ''},
  versions: {ffmpeg: 'ffmpeg version 7.1.5', ffprobe: 'ffprobe version 7.1.5'},
  capabilities: {filters: {drawtext: true, subtitles: true, zscale: true, loudnorm: true, ebur128: true},
    encoders: {libx264: true, aac: true, libwebp: true, libwebp_anim: true}},
  cliCapabilities: {filterArgumentFromFile: true, complexFilterArgumentFromFile: true, fpsModePassthrough: true, pngEncode: true, pngDecode: true},
};

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-macos-media-toolchain-')));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const file = async (name: string, contents: string) => {
    const target = path.join(directory, name);
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, contents);
    return target;
  };
  const media = path.join(directory, 'media.json'), output = path.join(directory, 'evidence/toolchain.json');
  await file('media.json', JSON.stringify(probe));
  return {directory, file, media, output};
}

function brewInfo(formulae: unknown): string {return JSON.stringify({formulae});}

test('bottle identity accepts only the reviewed arm64 macOS 15 ffmpeg@7 SHA-256', () => {
  assert.equal(bottleShaFromInfo({formulae: [{name: 'ffmpeg@7', bottle: {stable: {files: {arm64_sequoia: {sha256: sha}}}}}]}), sha);
  for (const value of [null, {}, {formulae: 'x'}]) {
    assert.throws(() => bottleShaFromInfo(value), {code: 'INVALID_BREW_INFO'}, JSON.stringify(value));
  }
  for (const value of [
    {formulae: []},
    {formulae: [{name: 'other', bottle: {stable: {files: {arm64_sequoia: {sha256: sha}}}}}]},
    {formulae: [{name: 'ffmpeg@7', bottle: {stable: {files: {arm64_sequoia: {sha256: 'ABC'}}}}}]},
    {formulae: [{name: 'ffmpeg@7', bottle: {stable: {files: {sonoma: {sha256: sha}}}}}]},
  ]) assert.throws(() => bottleShaFromInfo(value), {code: 'FFMPEG7_BOTTLE_NOT_FOUND'});
});

test('cached bottle bytes are re-hashed and foreign file types are rejected', async t => {
  const {directory, file} = await fixture(t);
  const archive = await file('archive.tar.gz', 'reviewed bottle bytes');
  const expected = createHash('sha256').update('reviewed bottle bytes').digest('hex');
  assert.equal(await sha256File(archive), expected);
  await verifyBottleArchive(archive, expected);
  await assert.rejects(verifyBottleArchive(archive, sha), {code: 'BOTTLE_HASH_MISMATCH'});
  await assert.rejects(verifyBottleArchive(path.join(directory, 'missing.tar.gz'), expected), {code: 'BOTTLE_ARCHIVE_UNAVAILABLE'});
  await writeFile(path.join(directory, 'empty.tar.gz'), '');
  await assert.rejects(verifyBottleArchive(path.join(directory, 'empty.tar.gz'), expected), {code: 'BOTTLE_ARCHIVE_INVALID'});
  if (process.platform !== 'win32') {
    await symlink(archive, path.join(directory, 'linked.tar.gz'));
    await assert.rejects(verifyBottleArchive(path.join(directory, 'linked.tar.gz'), expected), {code: 'BOTTLE_ARCHIVE_INVALID'});
  }
});

test('capability evidence combines the bottle identity, cache state and tool bytes', async t => {
  const {directory, file, media, output} = await fixture(t);
  const ffmpeg = await file('tools/ffmpeg', 'ffmpeg bytes'), ffprobe = await file('tools/ffprobe', 'ffprobe bytes');
  await writeFile(path.join(directory, 'media.json'), JSON.stringify({...probe, tools: {ffmpeg, ffprobe}}));
  const evidence = await writeToolchainEvidence({bottleSha: sha, cacheState: 'hit', mediaFile: media, output}) as Record<string, unknown>;
  const written = JSON.parse(await readFile(output, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(written, evidence);
  assert.deepEqual((written.bottle as Record<string, unknown>), {sha256: sha, cache: 'hit'});
  const tools = written.tools as Record<string, Record<string, string>>;
  assert.equal(tools.ffmpeg!.sha256, createHash('sha256').update('ffmpeg bytes').digest('hex'));
  assert.equal(tools.ffprobe!.path, ffprobe);
  assert.deepEqual(written.capabilities, probe.capabilities);
  assert.deepEqual(written.cliCapabilities, probe.cliCapabilities);
  assert.equal(written.platform, 'darwin');
  assert.equal(written.schema, 1);
});

test('capability evidence fails closed on a missing capability or a failed probe', async t => {
  const {file, media, output} = await fixture(t);
  const ffmpeg = await file('tools/ffmpeg', 'ffmpeg bytes'), ffprobe = await file('tools/ffprobe', 'ffprobe bytes');
  const writeProbe = (value: unknown) => writeFile(media, JSON.stringify(value));
  const toolPaths = {tools: {ffmpeg, ffprobe}};
  await writeProbe({...probe, ...toolPaths, capabilities: {filters: {drawtext: false}, encoders: {libx264: true}}});
  await assert.rejects(writeToolchainEvidence({bottleSha: sha, cacheState: 'hit', mediaFile: media, output}), {code: 'MEDIA_CAPABILITY_MISSING'});
  await writeProbe({...probe, ...toolPaths, ok: false});
  await assert.rejects(writeToolchainEvidence({bottleSha: sha, cacheState: 'hit', mediaFile: media, output}), {code: 'MEDIA_PROBE_NOT_SUCCESSFUL'});
  await writeProbe({...probe, ...toolPaths, cliCapabilities: {pngEncode: false}});
  await assert.rejects(writeToolchainEvidence({bottleSha: sha, cacheState: 'hit', mediaFile: media, output}), {code: 'MEDIA_CAPABILITY_MISSING'});
  await writeProbe({...probe, ...toolPaths});
  await assert.rejects(writeToolchainEvidence({bottleSha: sha, cacheState: 'bogus' as never, mediaFile: media, output}), {code: 'INVALID_CACHE_STATE'});
});

test('the media toolchain CLI reads the brew metadata and verifies a cached bottle', async t => {
  const {directory, file} = await fixture(t);
  const info = await file('brew-info.json', brewInfo([{name: 'ffmpeg@7', bottle: {stable: {files: {arm64_sequoia: {sha256: sha}}}}}]) );
  const cli = spawnSync(process.execPath, ['.github/scripts/macos-media-toolchain.ts', 'bottle-sha', `--input=${info}`],
    {cwd: root, env: testEnv(), encoding: 'utf8', timeout: 20000, shell: false, windowsHide: true});
  assert.equal(cli.error, undefined); assert.equal(cli.signal, null);
  assert.equal(cli.status, 0); assert.equal(cli.stdout, sha + '\n');
  const archive = await file('archive.tar.gz', 'reviewed bottle bytes');
  const expected = createHash('sha256').update('reviewed bottle bytes').digest('hex');
  const verified = spawnSync(process.execPath, ['.github/scripts/macos-media-toolchain.ts', 'verify-bottle', `--archive=${archive}`, `--sha=${expected}`],
    {cwd: root, env: testEnv(), encoding: 'utf8', timeout: 20000, shell: false, windowsHide: true});
  assert.equal(verified.status, 0); assert.equal(verified.stdout, 'bottle=verified\n');
  const rejected = spawnSync(process.execPath, ['.github/scripts/macos-media-toolchain.ts', 'verify-bottle', `--archive=${archive}`, `--sha=${sha}`],
    {cwd: root, env: testEnv(), encoding: 'utf8', timeout: 20000, shell: false, windowsHide: true});
  assert.equal(rejected.status, 1); assert.equal(rejected.stderr.trim(), 'BOTTLE_HASH_MISMATCH');
  assert.equal(await readFile(path.join(directory, 'nothing-written'), 'utf8').catch(() => 'absent'), 'absent');
});

test('the macOS media workflow uses the cached, re-verified toolchain and uploads capability evidence', async () => {
  const action = await readFile(path.join(root, '.github/actions/macos-media-toolchain/action.yml'), 'utf8');
  assert.match(action, /actions\/cache\/restore@/);
  assert.match(action, /actions\/cache\/save@/);
  assert.match(action, /key: mioon-ffmpeg7-arm64-sequoia-\$\{\{ steps\.bottle\.outputs\.sha \}\}/);
  assert.match(action, /path: \$\{\{ runner\.temp \}\}\/mioon-ffmpeg7-bottle\/archive\.tar\.gz/);
  assert.match(action, /bottle-sha --input=/);
  assert.match(action, /verify-bottle --archive="\$bottle_archive" --sha="\$BOTTLE_SHA"/);
  assert.match(action, /brew info --json=v2 ffmpeg@7/);
  assert.match(action, /brew install ffmpeg@7/);
  assert.match(action, /brew --prefix ffmpeg@7/);
  assert.match(action, /media-environment\.ts --platform=darwin --output=artifacts\/macos-media-environment\/media\.json/);
  assert.match(action, /printf '%s\/bin' "\$mioon_media_prefix" >> "\$GITHUB_PATH"/);
  assert.match(action, /macos-media-toolchain\.ts evidence/);
  const workflow = await readFile(path.join(root, '.github/workflows/macos-media-toolchain.yml'), 'utf8');
  assert.match(workflow, /^on:\r?\n  workflow_dispatch:$/m);
  assert.doesNotMatch(workflow, /^  (push|pull_request):/m);
  assert.match(workflow, /runs-on: macos-15/);
  assert.match(workflow, /timeout-minutes: 60/);
  assert.match(workflow, /uses: \.\/\.github\/actions\/macos-media-toolchain/);
  assert.match(workflow, /node scripts\/tooling\.ts test --suite=macos-media --concurrency=2 --reporter=tap/);
  assert.match(workflow, /name: macos-media-toolchain-evidence/);
  assert.match(workflow, /path: artifacts\/macos-media-environment\//);
  assert.match(workflow, /concurrency:\r?\n  group: macos-media-toolchain-\$\{\{ github\.ref \}\}\r?\n  cancel-in-progress: false/);
});
