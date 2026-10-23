import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, lstat, mkdtemp, mkdir, open, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildJobs, configureArguments, downloadSource, FFMPEG_LIBRARIES, FFMPEG_SOURCE, FFMPEG_TIMEOUTS, installFFmpeg, safeBuildLog, sourceDigest} from '../.github/scripts/install-ffmpeg.ts';
import type {InstallTransport} from '../.github/scripts/install-ffmpeg.ts';

const bytes = Buffer.from('owned synthetic FFmpeg source transport fixture');
const source = {...FFMPEG_SOURCE, sha256: createHash('sha256').update(bytes).digest('hex')};
interface Call {file: string; args: readonly string[]; cwd: string; timeout: number}
async function fixture(t: TestContext) {
  const runnerTemp = await mkdtemp(path.join(tmpdir(), 'mioon-ffmpeg-installer-test-'));
  t.after(() => rm(runnerTemp, {recursive: true, force: true}));
  const githubPath = path.join(runnerTemp, 'github-path'), githubEnv = path.join(runnerTemp, 'github-env'), githubSummary = path.join(runnerTemp, 'github-summary');
  const calls: Call[] = []; let prefix: string | undefined, downloads = 0;
  const transport: InstallTransport = {
    platform: 'linux', arch: 'x64', uid: 1001, cpuCount: 64,
    download: async (url, file) => {assert.equal(url, FFMPEG_SOURCE.url); downloads += 1; await writeFile(file, bytes);},
    run: async (file, args, options) => {
      calls.push({file, args, ...options});
      if (file === 'tar') {await writeFile(path.join(options.cwd, 'source/configure'), 'synthetic configure'); return '';}
      if (file.endsWith('configure')) {prefix = args.find(argument => argument.startsWith('--prefix='))?.slice(9); return '';}
      if (file === 'make' && args[0] === 'install') {
        assert.ok(prefix); await mkdir(path.join(prefix, 'bin'), {recursive: true});
        for (const name of ['ffmpeg', 'ffprobe']) {const output = path.join(prefix, 'bin', name); await writeFile(output, 'synthetic executable'); await chmod(output, 0o755);}
        return '';
      }
      if (path.basename(file) === 'ffmpeg' || path.basename(file) === 'ffprobe') return `${path.basename(file)} version 7.1.5 synthetic\n`;
      return '';
    }
  };
  return {options: {runnerTemp, githubPath, githubEnv, githubSummary}, transport, calls, get downloads() {return downloads;}};
}
test('FFmpeg source mirror URL and SHA256 are fixed to the authenticated official release bytes', () => {
  assert.equal(FFMPEG_SOURCE.version, '7.1.5');
  assert.equal(FFMPEG_SOURCE.url, 'https://github.com/starroyhq/mioon/releases/download/ci-ffmpeg-7.1.5/ffmpeg-7.1.5.tar.xz');
  assert.equal(FFMPEG_SOURCE.sha256, 'de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f');
  assert.equal(Object.isFrozen(FFMPEG_SOURCE), true);
});
test('installer rejects unsupported hosts and root before touching the source', async t => {
  const f = await fixture(t);
  for (const override of [{platform: 'darwin' as const}, {platform: 'win32' as const}, {arch: 'arm64'}, {uid: 0}, {uid: undefined}]) {
    await assert.rejects(installFFmpeg(f.options, {...f.transport, ...override}, source), /REQUIRES_LINUX_X64|REQUIRES_NON_ROOT/);
  }
  assert.equal(f.downloads, 0); assert.deepEqual(await readdir(f.options.runnerTemp), []);
});
test('hash mismatch rejects before extraction and cleans the owned temporary directory', async t => {
  const f = await fixture(t);
  await assert.rejects(installFFmpeg(f.options, f.transport), {message: 'FFMPEG_SOURCE_SHA256_MISMATCH'});
  assert.equal(f.downloads, 1); assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(f.options.runnerTemp), []);
});
test('configure preserves default built-in codecs and enables the required media libraries', () => {
  const args = configureArguments('/owned prefix/install');
  assert.equal(args[0], '--prefix=/owned prefix/install');
  for (const name of ['gpl', 'pthreads', 'zlib', 'libx264', 'libass', 'libfontconfig', 'libfreetype', 'libharfbuzz', 'libwebp', 'libzimg', 'libfribidi', 'libvpx', 'libmp3lame']) assert.ok(args.includes(`--enable-${name}`));
  assert.equal(FFMPEG_LIBRARIES.length, 13);
  assert.ok(args.includes('--enable-zlib'), 'PNG codecs require explicitly enabled zlib when autodetection is disabled');
  assert.ok(args.includes('--enable-pthreads'), 'media composition must retain native threading support');
  for (const value of ['--disable-everything', '--disable-codecs', '--disable-decoders', '--disable-encoders', '--disable-filters']) assert.ok(!args.includes(value));
  for (const value of ['--disable-doc', '--disable-debug', '--disable-ffplay']) assert.ok(args.includes(value));
  assert.equal(buildJobs(0), 1); assert.equal(buildJobs(2), 2); assert.equal(buildJobs(64), 4); assert.equal(buildJobs(NaN), 1);
});
test('successful fixture install exports absolute tool paths only after verification and source cleanup', async t => {
  const f = await fixture(t), result = await installFFmpeg(f.options, f.transport, source);
  assert.equal(result.ok, true); assert.equal(result.jobs, 4); assert.equal(result.sourceSha256, source.sha256);
  assert.ok(path.isAbsolute(result.ffmpeg)); assert.ok(path.isAbsolute(result.ffprobe));
  const owned = path.dirname(path.dirname(path.dirname(result.ffmpeg)));
  assert.deepEqual(await readdir(owned), ['install']);
  assert.equal(await readFile(f.options.githubPath, 'utf8'), `${path.dirname(result.ffmpeg)}\n`);
  assert.equal(await readFile(f.options.githubEnv, 'utf8'), `MIOON_FFMPEG_PATH=${result.ffmpeg}\nMIOON_FFPROBE_PATH=${result.ffprobe}\n`);
  assert.match(await readFile(f.options.githubSummary, 'utf8'), /FFmpeg 7\.1\.5 \/ Linux x64/);
  assert.deepEqual(f.calls.find(call => call.file === 'make' && call.args[0] !== 'install')?.args, ['-j4']);
  assert.equal(f.calls.find(call => call.file === 'make' && call.args[0] !== 'install')?.timeout, FFMPEG_TIMEOUTS.build);
  assert.equal(f.calls.find(call => call.file === 'tar')?.timeout, FFMPEG_TIMEOUTS.extract);
});
test('build failure cleans source and installation without exporting tools or leaking command text', async t => {
  const f = await fixture(t), original = f.transport.run;
  f.transport.run = async (file, args, options) => {if (file === 'make') throw new Error('synthetic-private-child-output'); return original(file, args, options);};
  await assert.rejects(installFFmpeg(f.options, f.transport, source), error => error instanceof Error && error.message === 'FFMPEG_BUILD_FAILED' && !error.message.includes('synthetic-private'));
  assert.deepEqual(await readdir(f.options.runnerTemp), []);
});
test('an installed older FFmpeg version cannot be exported as the new toolchain', async t => {
  const f = await fixture(t), original = f.transport.run;
  f.transport.run = async (file, args, options) => path.basename(file) === 'ffmpeg' ? 'ffmpeg version 4.4.2 old\n' : original(file, args, options);
  await assert.rejects(installFFmpeg(f.options, f.transport, source), {message: 'FFMPEG_INSTALLED_VERSION_MISMATCH'});
  assert.deepEqual(await readdir(f.options.runnerTemp), []);
});
test('source hashing reads the actual regular fixture file', async t => {
  const f = await fixture(t), archive = path.join(f.options.runnerTemp, 'fixture.tar.xz');
  await writeFile(archive, bytes); assert.equal(await sourceDigest(archive), source.sha256);
});
test('controlled build diagnostics have bounded tails, scrub paths and remove terminal controls', () => {
  const text = '\u001b[31mcompile /home/runner/work/_temp/owned/source in /home/runner\u001b[0m\u0000\n';
  const log = safeBuildLog(text, {RUNNER_TEMP: '/home/runner/work/_temp', HOME: '/home/runner'});
  assert.equal(log, 'compile <RUNNER_TEMP>/owned/source in <HOME>\n');
  assert.equal(safeBuildLog('x'.repeat(50000), {}).length, 32768);
});

function networkError(code = 'ECONNRESET'): TypeError {
  return new TypeError('synthetic-private-message-and-url', {cause: Object.assign(new Error('synthetic-private-cause'), {code})});
}
function downloadFixture(request: typeof fetch) {
  let clock = 0;
  const pauses: number[] = [], timeouts: number[] = [], diagnostics: string[] = [];
  return {pauses, timeouts, diagnostics, advance(milliseconds: number) {clock += milliseconds;}, services: {
    fetch: request, now: () => clock,
    pause: async (milliseconds: number) => {pauses.push(milliseconds); clock += milliseconds;},
    timeoutSignal: (milliseconds: number) => {timeouts.push(milliseconds); return new AbortController().signal;},
    diagnostic: (code: string) => {diagnostics.push(code);},
  }};
}
const mirroredAssetUrl = 'https://release-assets.githubusercontent.com/github-production-release-asset/owned/ffmpeg-7.1.5.tar.xz?synthetic-private-signature=fixture';
function redirectResponse(location: string, status = 302, cancelled: () => void = () => {}): Response {
  return new Response(new ReadableStream<Uint8Array>({cancel: cancelled}), {status, headers: {location}});
}
test('only the pinned mirror may redirect once to the public GitHub asset host with the same signal', async t => {
  const f = await fixture(t);
  for (const status of [301, 302, 303, 307, 308]) {
    const requests: string[] = [], signals: (AbortSignal | null | undefined)[] = []; let cancelled = 0;
    const d = downloadFixture(async (input, options) => {
      requests.push(String(input)); signals.push(options?.signal);
      assert.equal(options?.redirect, 'manual'); assert.equal(options?.headers, undefined); assert.equal(options?.credentials, undefined);
      return requests.length === 1 ? redirectResponse(mirroredAssetUrl, status, () => {cancelled += 1;}) : new Response(bytes);
    });
    const file = path.join(f.options.runnerTemp, `redirect-${status}.tar.xz`);
    await downloadSource(FFMPEG_SOURCE.url, file, d.services);
    assert.deepEqual(requests, [FFMPEG_SOURCE.url, mirroredAssetUrl]);
    assert.ok(signals[0]); assert.equal(signals[0], signals[1]); assert.deepEqual(d.timeouts, [120000]);
    assert.equal(cancelled, 1); assert.deepEqual(d.diagnostics, []); assert.deepEqual(d.pauses, []);
    assert.deepEqual(await readFile(file), bytes); assert.equal(await sourceDigest(file), source.sha256);
  }
});
test('redirect targets outside the exact HTTPS asset host are rejected and cancelled without retries or URL leakage', async t => {
  const f = await fixture(t);
  const targets = [
    'https://example.com/synthetic-private', 'http://release-assets.githubusercontent.com/synthetic-private',
    'https://synthetic-private@release-assets.githubusercontent.com/asset',
    'https://release-assets.githubusercontent.com:8443/asset',
    'https://release-assets.githubusercontent.com/asset#synthetic-private',
    'https://release-assets.githubusercontent.com/asset#',
    'https://release-assets.githubusercontent.com.example.com/asset',
    'https://sub.release-assets.githubusercontent.com/asset', '/relative-synthetic-private', 'not-a-synthetic-private-url'
  ];
  for (const [index, target] of targets.entries()) {
    let requests = 0, cancelled = 0;
    const d = downloadFixture(async () => {requests += 1; return redirectResponse(target, 302, () => {cancelled += 1;});});
    const file = path.join(f.options.runnerTemp, `invalid-redirect-${index}`);
    await assert.rejects(downloadSource(FFMPEG_SOURCE.url, file, d.services), {message: 'FFMPEG_DOWNLOAD_REDIRECT_NOT_ALLOWED'});
    assert.equal(requests, 1); assert.equal(cancelled, 1); assert.deepEqual(d.pauses, []);
    assert.deepEqual(d.diagnostics, ['FFMPEG_DOWNLOAD_REDIRECT_NOT_ALLOWED']);
    await assert.rejects(readFile(file), {code: 'ENOENT'});
  }
});
test('redirect exceptions do not apply to other initial URLs and cannot follow a second asset redirect', async t => {
  const f = await fixture(t);
  for (const initialUrl of ['https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz', `${FFMPEG_SOURCE.url}?override=synthetic-private`, mirroredAssetUrl]) {
    let requests = 0, cancelled = 0;
    const d = downloadFixture(async () => {requests += 1; return redirectResponse(mirroredAssetUrl, 302, () => {cancelled += 1;});});
    await assert.rejects(downloadSource(initialUrl, path.join(f.options.runnerTemp, `other-${encodeURIComponent(initialUrl)}`), d.services), {message: 'FFMPEG_DOWNLOAD_REDIRECT_NOT_ALLOWED'});
    assert.equal(requests, 1); assert.equal(cancelled, 1); assert.deepEqual(d.pauses, []);
  }
  let requests = 0, cancelled = 0;
  const d = downloadFixture(async () => {requests += 1; return redirectResponse(mirroredAssetUrl, 302, () => {cancelled += 1;});});
  await assert.rejects(downloadSource(FFMPEG_SOURCE.url, path.join(f.options.runnerTemp, 'redirect-loop'), d.services), {message: 'FFMPEG_DOWNLOAD_REDIRECT_NOT_ALLOWED'});
  assert.equal(requests, 2); assert.equal(cancelled, 2); assert.deepEqual(d.timeouts, [120000]); assert.deepEqual(d.pauses, []);
});
test('redirects and retries share the original download budget without replacing the per-attempt signal', async t => {
  const f = await fixture(t), file = path.join(f.options.runnerTemp, 'redirect-budget.tar.xz');
  const signals: (AbortSignal | null | undefined)[] = []; let requests = 0;
  const d = downloadFixture(async (_input, options) => {
    signals.push(options?.signal);
    if (++requests === 1) {d.advance(40000); return redirectResponse(mirroredAssetUrl);}
    if (requests === 2) throw networkError('UND_ERR_CONNECT_TIMEOUT');
    if (requests === 3) return redirectResponse(mirroredAssetUrl);
    return new Response(bytes);
  });
  await downloadSource(FFMPEG_SOURCE.url, file, d.services);
  assert.equal(requests, 4); assert.equal(signals[0], signals[1]); assert.equal(signals[2], signals[3]); assert.notEqual(signals[0], signals[2]);
  assert.deepEqual(d.timeouts, [120000, 79500]); assert.deepEqual(d.pauses, [500]);
  assert.deepEqual(d.diagnostics, ['FFMPEG_DOWNLOAD_NETWORK_UND_ERR_CONNECT_TIMEOUT']); assert.deepEqual(await readFile(file), bytes);
});
test('an exhausted signal while cancelling a redirect prevents dispatch to the asset host', async t => {
  const f = await fixture(t), file = path.join(f.options.runnerTemp, 'redirect-abort.tar.xz'), controller = new AbortController(); let requests = 0;
  const d = downloadFixture(async () => {
    requests += 1;
    return redirectResponse(mirroredAssetUrl, 302, () => {d.advance(120000); controller.abort();});
  });
  d.services.timeoutSignal = () => controller.signal;
  await assert.rejects(downloadSource(FFMPEG_SOURCE.url, file, d.services), {message: 'FFMPEG_DOWNLOAD_DEADLINE_EXCEEDED'});
  assert.equal(requests, 1); assert.deepEqual(d.pauses, []); assert.deepEqual(d.diagnostics, ['FFMPEG_DOWNLOAD_TIMEOUT']);
  await assert.rejects(readFile(file), {code: 'ENOENT'});
});
test('source download retries one known transient failure then returns the complete verified fixture bytes', async t => {
  const f = await fixture(t), file = path.join(f.options.runnerTemp, 'download.tar.xz'); let requests = 0;
  const d = downloadFixture(async (_input, options) => {
    assert.equal(options?.redirect, 'manual'); assert.ok(options?.signal);
    if (++requests === 1) throw networkError();
    return new Response(bytes);
  });
  await downloadSource(FFMPEG_SOURCE.url, file, d.services);
  assert.equal(requests, 2); assert.deepEqual(d.pauses, [500]); assert.deepEqual(d.timeouts, [120000, 119500]);
  assert.deepEqual(await readFile(file), bytes); assert.equal(await sourceDigest(file), source.sha256);
  assert.deepEqual(d.diagnostics, ['FFMPEG_DOWNLOAD_NETWORK_ECONNRESET']);
});
test('a partial response stream failure is removed before a full fresh download', async t => {
  const f = await fixture(t), file = path.join(f.options.runnerTemp, 'stream.tar.xz'); let requests = 0;
  const d = downloadFixture(async () => {
    if (++requests === 1) {
      let pulls = 0;
      return new Response(new ReadableStream<Uint8Array>({pull(controller) {if (++pulls === 1) controller.enqueue(Buffer.from('incomplete prefix')); else controller.error(networkError('UND_ERR_SOCKET'));}}));
    }
    assert.equal((await readFile(file)).length, 0, 'the next attempt starts with a new empty exclusive file');
    return new Response(bytes);
  });
  await downloadSource(FFMPEG_SOURCE.url, file, d.services);
  assert.equal(requests, 2); assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(d.diagnostics, ['FFMPEG_DOWNLOAD_NETWORK_UND_ERR_SOCKET']);
});
test('retryable HTTP failures exhaust at three attempts with bounded fixed diagnostics', async t => {
  const f = await fixture(t), file = path.join(f.options.runnerTemp, 'exhaust.tar.xz'); let requests = 0;
  const d = downloadFixture(async () => {requests += 1; return new Response('synthetic-private-error-body', {status: 503});});
  await assert.rejects(downloadSource(FFMPEG_SOURCE.url, file, d.services), {message: 'FFMPEG_DOWNLOAD_HTTP_503'});
  assert.equal(requests, 3); assert.deepEqual(d.pauses, [500, 1000]); assert.deepEqual(d.timeouts, [120000, 119500, 118500]);
  assert.deepEqual(d.diagnostics, Array(3).fill('FFMPEG_DOWNLOAD_HTTP_503'));
  await assert.rejects(readFile(file), {code: 'ENOENT'});
});
test('only HTTP 408, 429 and 5xx are retried', async t => {
  const f = await fixture(t);
  for (const status of [408, 429, 500, 599]) {
    let requests = 0;
    const d = downloadFixture(async () => ++requests === 1 ? new Response('temporary', {status}) : new Response(bytes));
    await downloadSource(FFMPEG_SOURCE.url, path.join(f.options.runnerTemp, `http-${status}`), d.services);
    assert.equal(requests, 2); assert.deepEqual(d.diagnostics, [`FFMPEG_DOWNLOAD_HTTP_${status}`]);
  }
  for (const status of [301, 302, 400, 403, 404]) {
    let requests = 0;
    const d = downloadFixture(async () => {requests += 1; return new Response('synthetic-private-response', {status});});
    await assert.rejects(downloadSource(FFMPEG_SOURCE.url, path.join(f.options.runnerTemp, `http-${status}`), d.services), {message: `FFMPEG_DOWNLOAD_HTTP_${status}`});
    assert.equal(requests, 1); assert.deepEqual(d.pauses, []);
  }
});
test('unknown errors and rejected redirects are not retried or exposed', async t => {
  const f = await fixture(t);
  for (const error of [new Error('synthetic-private-message'), new TypeError('synthetic-private-url', {cause: new Error('unexpected redirect')}), networkError('CERT_HAS_EXPIRED')]) {
    let requests = 0;
    const d = downloadFixture(async () => {requests += 1; throw error;});
    await assert.rejects(downloadSource(FFMPEG_SOURCE.url, path.join(f.options.runnerTemp, `unknown-${requests}`), d.services), {message: 'FFMPEG_DOWNLOAD_NON_NETWORK_ERROR'});
    assert.equal(requests, 1); assert.deepEqual(d.pauses, []); assert.deepEqual(d.diagnostics, ['FFMPEG_DOWNLOAD_NON_NETWORK_ERROR']);
  }
});
test('timeout retry consumes the same original 120-second download budget', async t => {
  const f = await fixture(t), file = path.join(f.options.runnerTemp, 'timeout.tar.xz'); let requests = 0;
  const d = downloadFixture(async () => {
    if (++requests === 1) {d.advance(10000); throw new DOMException('synthetic-private-timeout', 'TimeoutError');}
    return new Response(bytes);
  });
  await downloadSource(FFMPEG_SOURCE.url, file, d.services);
  assert.deepEqual(d.timeouts, [120000, 109500]); assert.deepEqual(d.diagnostics, ['FFMPEG_DOWNLOAD_TIMEOUT']);
  const exhausted = downloadFixture(async () => {exhausted.advance(119700); throw networkError();});
  await assert.rejects(downloadSource(FFMPEG_SOURCE.url, path.join(f.options.runnerTemp, 'deadline.tar.xz'), exhausted.services), {message: 'FFMPEG_DOWNLOAD_DEADLINE_EXCEEDED'});
  assert.deepEqual(exhausted.timeouts, [120000]); assert.deepEqual(exhausted.pauses, []);
});
test('oversize header or body stops immediately and removes only its own partial file', async t => {
  const f = await fixture(t);
  for (const oversized of [() => new Response(bytes, {headers: {'content-length': String(64 * 1024 * 1024 + 1)}}), () => new Response(new Uint8Array(64 * 1024 * 1024 + 1))]) {
    let requests = 0; const file = path.join(f.options.runnerTemp, 'too-large.tar.xz');
    const d = downloadFixture(async () => {requests += 1; return oversized();});
    await assert.rejects(downloadSource(FFMPEG_SOURCE.url, file, d.services), {message: 'FFMPEG_SOURCE_TOO_LARGE'});
    assert.equal(requests, 1); assert.deepEqual(d.pauses, []); await assert.rejects(readFile(file), {code: 'ENOENT'});
  }
});
test('hash mismatch after a complete mirrored download never retries or extracts', async t => {
  const f = await fixture(t); let requests = 0;
  const d = downloadFixture(async () => ++requests === 1 ? redirectResponse(mirroredAssetUrl) : new Response(bytes));
  f.transport.download = (url, file) => downloadSource(url, file, d.services);
  await assert.rejects(installFFmpeg(f.options, f.transport), {message: 'FFMPEG_SOURCE_SHA256_MISMATCH'});
  assert.equal(requests, 2); assert.equal(f.calls.length, 0); assert.deepEqual(d.pauses, []);
  assert.deepEqual(await readdir(f.options.runnerTemp), []);
});
test('an existing file is refused before networking and cannot be removed or overwritten', async t => {
  const f = await fixture(t), file = path.join(f.options.runnerTemp, 'existing.tar.xz');
  await writeFile(file, 'synthetic existing work'); const identity = await lstat(file); let requests = 0;
  const d = downloadFixture(async () => {requests += 1; throw networkError();});
  await assert.rejects(downloadSource(FFMPEG_SOURCE.url, file, d.services), {message: 'FFMPEG_DOWNLOAD_FILE_EXISTS'});
  assert.equal(requests, 0); assert.equal(await readFile(file, 'utf8'), 'synthetic existing work');
  const after = await lstat(file); assert.deepEqual({dev: after.dev, ino: after.ino}, {dev: identity.dev, ino: identity.ino});
  assert.deepEqual(d.pauses, []); assert.deepEqual(d.diagnostics, ['FFMPEG_DOWNLOAD_FILE_EXISTS']);
});
test('a coincident timeout cannot make a local write error retryable', async t => {
  const f = await fixture(t), file = path.join(f.options.runnerTemp, 'write-error.tar.xz'), controller = new AbortController();
  const handle = await open(path.join(f.options.runnerTemp, 'prototype-probe'), 'wx');
  const prototype = Object.getPrototypeOf(handle) as {writeFile: typeof handle.writeFile}; await handle.close();
  let requests = 0;
  const d = downloadFixture(async () => {requests += 1; return new Response(bytes);});
  d.services.timeoutSignal = () => controller.signal;
  t.mock.method(prototype, 'writeFile', async () => {controller.abort(); throw Object.assign(new Error('synthetic-private-disk-error'), {code: 'ENOSPC'});});
  await assert.rejects(downloadSource(FFMPEG_SOURCE.url, file, d.services), {message: 'FFMPEG_DOWNLOAD_WRITE_FAILED'});
  assert.equal(requests, 1); assert.deepEqual(d.pauses, []); assert.deepEqual(d.diagnostics, ['FFMPEG_DOWNLOAD_WRITE_FAILED']);
  await assert.rejects(readFile(file), {code: 'ENOENT'});
});
test('a coincident timeout preserves an explicit nonretryable size refusal', async t => {
  const f = await fixture(t), file = path.join(f.options.runnerTemp, 'size-and-timeout.tar.xz'), controller = new AbortController(); let requests = 0;
  const d = downloadFixture(async () => {requests += 1; controller.abort(); return new Response(bytes, {headers: {'content-length': String(64 * 1024 * 1024 + 1)}});});
  d.services.timeoutSignal = () => controller.signal;
  await assert.rejects(downloadSource(FFMPEG_SOURCE.url, file, d.services), {message: 'FFMPEG_SOURCE_TOO_LARGE'});
  assert.equal(requests, 1); assert.deepEqual(d.pauses, []); assert.deepEqual(d.diagnostics, ['FFMPEG_SOURCE_TOO_LARGE']);
  await assert.rejects(readFile(file), {code: 'ENOENT'});
});
