import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildJobs, configureArguments, FFMPEG_LIBRARIES, FFMPEG_SOURCE, FFMPEG_TIMEOUTS, installFFmpeg, safeBuildLog, sourceDigest} from '../.github/scripts/install-ffmpeg.ts';
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
test('FFmpeg source URL and SHA256 are fixed to the authenticated official release', () => {
  assert.equal(FFMPEG_SOURCE.version, '7.1.5');
  assert.equal(FFMPEG_SOURCE.url, 'https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz');
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
