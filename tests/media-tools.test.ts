import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {MEDIA_TOOLS_RELEASE, assertMediaToolsRelease, createMediaToolsInstaller, mediaToolsTarget} from '../apps/desktop/src/media-tools.ts';
import type {MediaToolsRelease} from '../apps/desktop/src/media-tools.ts';
import {MEDIA_TOOLS_CANCEL_TITLE, mediaToolsProgressPage, mediaToolsProgressScript} from '../apps/desktop/src/media-tools-window.ts';
import {assetName, MEDIA_TOOLS_VERSION, FFMPEG_VERSION} from '../.github/scripts/build-media-tools.ts';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const binaries = {ffmpeg: Buffer.from('#!/bin/sh\necho "ffmpeg version 7.1.5 synthetic"\n'), ffprobe: Buffer.from('#!/bin/sh\necho "ffprobe version 7.1.5 synthetic"\n')};
const archives = {ffmpeg: gzipSync(binaries.ffmpeg), ffprobe: gzipSync(binaries.ffprobe)};
const asset = (tool: 'ffmpeg' | 'ffprobe') => ({file: `mioon-${tool}-7.1.5-1-darwin-arm64.gz`, sha256: sha(archives[tool]), bytes: archives[tool].length,
  unpackedSha256: sha(binaries[tool]), unpackedBytes: binaries[tool].length});
const release: MediaToolsRelease = {...MEDIA_TOOLS_RELEASE, builds: {'darwin-arm64': {ffmpeg: asset('ffmpeg'), ffprobe: asset('ffprobe')}}};
type Served = {status?: number; body?: Buffer; url?: string; length?: number; fail?: boolean; hold?: Promise<void>};
const genuine = (file: string): Served => ({body: file.includes('ffprobe') ? archives.ffprobe : archives.ffmpeg});
function fixture(t: {after(callback: () => Promise<void>): void}, serve: (file: string) => Served = genuine, catalog: MediaToolsRelease = release) {
  const root = path.join(mkdtempSync(path.join(tmpdir(), 'mioon-media-tools-')), 'media-tools');
  t.after(() => rm(path.dirname(root), {recursive: true, force: true}));
  const requests: string[] = [], validated: string[][] = [];
  let validate = async (paths: {ffmpeg: string; ffprobe: string}) => {
    validated.push([paths.ffmpeg, paths.ffprobe]);
    assert.deepEqual(await readFile(paths.ffmpeg), binaries.ffmpeg);
  };
  const installer = createMediaToolsInstaller({root, release: catalog, platform: 'darwin', arch: 'arm64',
    prepareRoot: directory => { void directory; },
    createStaging: directory => mkdtempSync(path.join(directory, 'download-')),
    validate: (paths, _signal) => validate(paths),
    fetch: async (url, init) => {
      requests.push(url);
      const served = serve(url);
      if (served.fail) throw Object.assign(new Error('synthetic network'), {code: 'ECONNRESET'});
      await served.hold;
      init.signal.throwIfAborted();
      const body = served.body ?? Buffer.alloc(0);
      const headers = new Headers(served.length === undefined ? {'content-length': String(body.length)} : {'content-length': String(served.length)});
      const stream = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new Uint8Array(body)); controller.close();}});
      return {ok: (served.status ?? 200) < 300, status: served.status ?? 200, url: served.url ?? url, headers, body: stream} as unknown as Response;
    }});
  return {root, installer, requests, validated, setValidate(next: typeof validate) {validate = next;}};
}
const prepare = async (root: string) => mkdir(root, {recursive: true, mode: 0o700});

test('the pinned catalog is well formed, uses the build script names and is offered only on macOS', () => {
  assertMediaToolsRelease(MEDIA_TOOLS_RELEASE);
  assert.equal(MEDIA_TOOLS_RELEASE.version, MEDIA_TOOLS_VERSION);
  assert.equal(MEDIA_TOOLS_RELEASE.ffmpegVersion, FFMPEG_VERSION);
  assert.ok(MEDIA_TOOLS_RELEASE.baseUrl.endsWith(`/media-tools-${MEDIA_TOOLS_VERSION}/`));
  for (const [target, build] of Object.entries(MEDIA_TOOLS_RELEASE.builds)) {
    const arch = target === 'darwin-arm64' ? 'arm64' : 'x64';
    assert.equal(build!.ffmpeg.file, assetName('ffmpeg', arch));
    assert.equal(build!.ffprobe.file, assetName('ffprobe', arch));
  }
  assert.equal(mediaToolsTarget('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(mediaToolsTarget('darwin', 'x64'), 'darwin-x64');
  for (const [platform, arch] of [['linux', 'x64'], ['win32', 'x64'], ['darwin', 'ia32']]) assert.equal(mediaToolsTarget(platform!, arch!), null);
  for (const invalid of [{baseUrl: 'http://example.com/assets/'}, {baseUrl: 'https://example.com/assets'}, {version: '7.1.5'}, {version: '7.1.6-1'}]) {
    assert.throws(() => assertMediaToolsRelease({...release, ...invalid}));
  }
  assert.throws(() => assertMediaToolsRelease({...release, builds: {'darwin-arm64': {ffmpeg: {...asset('ffmpeg'), sha256: 'abc'}, ffprobe: asset('ffprobe')}}}));
  const linux = createMediaToolsInstaller({root: '/unused', release, platform: 'linux', arch: 'x64', fetch: async () => {throw new Error('unused');},
    prepareRoot: () => {}, createStaging: () => '/unused', validate: async () => {}});
  assert.equal(linux.offer(), null);
});

test('a verified download is installed privately, then reused without another request', async t => {
  const f = fixture(t);
  await prepare(f.root);
  const phases: string[] = [];
  f.installer.subscribe(progress => {if (phases.at(-1) !== progress.phase) phases.push(progress.phase);});
  assert.deepEqual(f.installer.offer(), {version: '7.1.5-1', ffmpegVersion: '7.1.5', arch: 'arm64', downloadBytes: archives.ffmpeg.length + archives.ffprobe.length,
    license: 'GPL-2.0-or-later', sourceUrl: MEDIA_TOOLS_RELEASE.sourceUrl});
  assert.equal(await f.installer.installedPaths(), null);
  const outcome = await f.installer.install();
  const directory = path.join(f.root, '7.1.5-1');
  assert.deepEqual(outcome, {ok: true, paths: {ffmpeg: path.join(directory, 'ffmpeg'), ffprobe: path.join(directory, 'ffprobe')}});
  assert.deepEqual(f.requests, [`${MEDIA_TOOLS_RELEASE.baseUrl}${asset('ffmpeg').file}`, `${MEDIA_TOOLS_RELEASE.baseUrl}${asset('ffprobe').file}`]);
  // Validation ran before installation, on the staged copy.
  assert.equal(f.validated.length, 1);
  assert.match(path.basename(path.dirname(f.validated[0]![0]!)), /^download-/u);
  for (const tool of ['ffmpeg', 'ffprobe'] as const) {
    assert.deepEqual(await readFile(path.join(directory, tool)), binaries[tool]);
    assert.equal((await stat(path.join(directory, tool))).mode & 0o777, 0o700);
  }
  assert.deepEqual(await readdir(f.root), ['7.1.5-1'], 'no staging directory remains');
  assert.deepEqual(phases, ['downloading', 'verifying', 'downloading', 'verifying', 'checking', 'installing', 'completed']);
  assert.deepEqual(await f.installer.installedPaths(), outcome.ok ? outcome.paths : null);
  assert.deepEqual(await f.installer.install(), outcome);
  assert.equal(f.requests.length, 2, 'a verified install is reused');
  assert.equal(f.validated.length, 2, 'a reused install is still validated');
});

test('checksum, size, HTTP, network and insecure redirect failures install nothing', async t => {
  // Flipping a CRC byte keeps the length but makes the gzip stream invalid.
  const tampered = Buffer.from(archives.ffmpeg); tampered[tampered.length - 5] ^= 1;
  const substituted: MediaToolsRelease = {...release, builds: {'darwin-arm64': {ffmpeg: {...asset('ffmpeg'), sha256: '0'.repeat(64)}, ffprobe: asset('ffprobe')}}};
  const cases: [string, (file: string) => Served, MediaToolsRelease?][] = [
    ['MEDIA_TOOLS_CHECKSUM_MISMATCH', genuine, substituted],
    ['MEDIA_TOOLS_SIZE_MISMATCH', () => ({body: archives.ffmpeg, length: archives.ffmpeg.length + 1})],
    ['MEDIA_TOOLS_ARCHIVE_INVALID', () => ({body: tampered})],
    ['MEDIA_TOOLS_DOWNLOAD_HTTP_404', () => ({status: 404})],
    ['MEDIA_TOOLS_DOWNLOAD_NETWORK', () => ({fail: true})],
    ['MEDIA_TOOLS_DOWNLOAD_INSECURE', file => ({body: archives.ffmpeg, url: file.replace('https:', 'http:')})],
  ];
  for (const [code, serve, catalog] of cases) {
    const f = fixture(t, serve, catalog);
    await prepare(f.root);
    const outcome = await f.installer.install();
    assert.deepEqual(outcome, {ok: false, code}, code);
    assert.deepEqual(await readdir(f.root), [], `${code} leaves no files`);
    assert.equal(f.validated.length, 0);
    assert.deepEqual(f.installer.progress().phase, 'failed');
    assert.equal(f.installer.progress().code, code);
  }
});

test('failed validation, cancellation and concurrent requests do not install or replace tools', async t => {
  const failing = fixture(t);
  await prepare(failing.root);
  failing.setValidate(async () => {throw new Error('synthetic missing encoder');});
  assert.deepEqual(await failing.installer.install(), {ok: false, code: 'MEDIA_TOOLS_CHECK_FAILED'});
  assert.deepEqual(await readdir(failing.root), []);

  let release!: () => void;
  const hold = new Promise<void>(resolve => {release = resolve;});
  const held = fixture(t, file => ({...genuine(file), hold}));
  await prepare(held.root);
  const pending = held.installer.install();
  await new Promise(setImmediate);
  assert.deepEqual(await held.installer.install(), {ok: false, code: 'MEDIA_TOOLS_BUSY'});
  assert.equal(held.installer.busy(), true);
  assert.equal(held.installer.cancel(), true);
  release();
  assert.deepEqual(await pending, {ok: false, code: 'MEDIA_TOOLS_CANCELLED'});
  assert.equal(held.installer.progress().phase, 'cancelled');
  assert.equal(held.installer.cancel(), false, 'nothing left to cancel');
  assert.deepEqual(await readdir(held.root), []);
});

test('a damaged earlier install is replaced only after the new copy is verified', async t => {
  const f = fixture(t);
  await prepare(f.root);
  const directory = path.join(f.root, '7.1.5-1');
  await mkdir(directory, {mode: 0o700});
  for (const tool of ['ffmpeg', 'ffprobe'] as const) {
    // Same size and permissions, different contents: only the full check notices.
    await writeFile(path.join(directory, tool), Buffer.alloc(binaries[tool].length, 0x20), {mode: 0o700});
  }
  assert.ok(await f.installer.installedPaths(), 'the quick status check sees a plausible install');
  assert.equal((await f.installer.install()).ok, true);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(await readFile(path.join(directory, 'ffmpeg')), binaries.ffmpeg);
  assert.deepEqual((await readdir(f.root)).sort(), ['7.1.5-1'], 'the previous copy was removed');
  assert.equal((await lstat(directory)).isDirectory(), true);
});

test('storage failures are reported without touching the network', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-media-tools-storage-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  let requests = 0;
  const installer = createMediaToolsInstaller({root, release, platform: 'darwin', arch: 'arm64', fetch: async () => {requests++; throw new Error('unused');},
    prepareRoot: () => {throw Object.assign(new Error('synthetic'), {code: 'STORAGE_PRIVATE_REQUIRED'});}, createStaging: () => root, validate: async () => {}});
  assert.deepEqual(await installer.install(), {ok: false, code: 'MEDIA_TOOLS_STORAGE_UNAVAILABLE'});
  assert.equal(requests, 0);
});

test('the first-run progress document is inert apart from its fixed progress and cancel hooks', () => {
  const page = mediaToolsProgressPage({lang: 'zh-Hans', title: '<安装>', heading: 'A & B', cancel: '取消"', phases: {downloading: '下载</script>', verifying: 'v', checking: 'c', installing: 'i'}});
  assert.match(page, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"/u);
  assert.match(page, /<title>&lt;安装&gt;<\/title>/u);
  assert.match(page, /A &amp; B/u);
  assert.doesNotMatch(page, /下载<\/script>/u, 'phase labels cannot close the script');
  assert.ok(page.includes(JSON.stringify(MEDIA_TOOLS_CANCEL_TITLE)));
  assert.doesNotMatch(page, /https?:\/\//u, 'no network resource is referenced');
  assert.equal(mediaToolsProgressScript({phase: 'downloading', receivedBytes: 10.7, totalBytes: 20, code: 'IGNORED'}),
    'window.mioonProgress({"phase":"downloading","receivedBytes":10,"totalBytes":20})');
});
