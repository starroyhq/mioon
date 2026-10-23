import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, constants} from 'node:fs';
import {access, appendFile, chmod, lstat, mkdir, mkdtemp, open, realpath, rm} from 'node:fs/promises';
import {availableParallelism} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

interface Source {readonly version: string; readonly url: string; readonly sha256: string}
// Byte-for-byte mirror of https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz,
// independently checked against the official .asc using release-key fingerprint
// FCF986EA15E6E293A5644F10B4322F04D67658D8. CI never falls back to mutable sources.
export const FFMPEG_SOURCE: Source = Object.freeze({
  version: '7.1.5',
  url: 'https://github.com/starroyhq/mioon/releases/download/ci-ffmpeg-7.1.5/ffmpeg-7.1.5.tar.xz',
  sha256: 'de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f'
});
export const FFMPEG_LIBRARIES = Object.freeze([
  'gpl', 'pthreads', 'zlib', 'libx264', 'libass', 'libfontconfig', 'libfreetype', 'libharfbuzz',
  'libwebp', 'libzimg', 'libfribidi', 'libvpx', 'libmp3lame'
]);
export const FFMPEG_TIMEOUTS = Object.freeze({download: 120000, extract: 120000, configure: 180000, build: 1200000, install: 180000, version: 30000});
const maximumArchiveBytes = 64 * 1024 * 1024;
export class FFmpegInstallFailure extends Error {
  readonly code: string;
  constructor(code: string) {super(code); this.name = 'FFmpegInstallFailure'; this.code = code;}
}
function fail(code: string): never {throw new FFmpegInstallFailure(code);}
export interface InstallTransport {
  platform: NodeJS.Platform;
  arch: string;
  uid: number | undefined;
  cpuCount: number;
  download: (url: string, file: string) => Promise<void>;
  run: (file: string, args: readonly string[], options: {cwd: string; timeout: number}) => Promise<string>;
}
export interface InstallOptions {runnerTemp: string; githubPath?: string; githubEnv?: string; githubSummary?: string}
export interface FFmpegInstallation {ok: true; version: string; platform: 'linux'; arch: 'x64'; sourceSha256: string; jobs: number; ffmpeg: string; ffprobe: string}
export async function sourceDigest(file: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maximumArchiveBytes) fail('FFMPEG_SOURCE_NOT_REGULAR');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
export function configureArguments(prefix: string): string[] {
  return [`--prefix=${prefix}`, '--disable-autodetect', '--disable-doc', '--disable-debug', '--disable-ffplay', ...FFMPEG_LIBRARIES.map(name => `--enable-${name}`)];
}
export function buildJobs(cpuCount: number): number {
  return Number.isFinite(cpuCount) ? Math.max(1, Math.min(4, Math.floor(cpuCount))) : 1;
}
function childEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) if (environment[name]) result[name] = environment[name];
  return result;
}
export function safeBuildLog(text: string, environment: NodeJS.ProcessEnv): string {
  let result = text.slice(-32768).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  for (const name of ['RUNNER_TEMP', 'HOME']) if (environment[name]) result = result.replaceAll(environment[name], `<${name}>`);
  return result;
}
interface DownloadServices {
  fetch: typeof fetch;
  now: () => number;
  pause: (milliseconds: number) => Promise<void>;
  timeoutSignal: (milliseconds: number) => AbortSignal;
  diagnostic: (code: string) => void;
}
class DownloadAttemptFailure extends FFmpegInstallFailure {
  readonly retryable: boolean;
  constructor(code: string, retryable: boolean) {super(code); this.retryable = retryable;}
}
const transientNetworkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
function mirrorRedirect(initialUrl: string, location: string, followed: number): string {
  // Public GitHub release downloads have exactly one hop to their signed asset
  // URL. Keep that exception local to this pinned mirror, without credentials.
  if (initialUrl !== FFMPEG_SOURCE.url || followed !== 0) fail('FFMPEG_DOWNLOAD_REDIRECT_NOT_ALLOWED');
  let target: URL;
  try {target = new URL(location);} catch {fail('FFMPEG_DOWNLOAD_REDIRECT_NOT_ALLOWED');}
  if (target.protocol !== 'https:' || target.hostname !== 'release-assets.githubusercontent.com' || target.username || target.password || target.port || target.hash || location.includes('#')) fail('FFMPEG_DOWNLOAD_REDIRECT_NOT_ALLOWED');
  return target.href;
}
function downloadFailure(error: unknown, phase: string): DownloadAttemptFailure {
  if (error instanceof DownloadAttemptFailure) return error;
  if (error instanceof FFmpegInstallFailure) return new DownloadAttemptFailure(error.code, false);
  if (phase === 'FETCH' || phase === 'STREAM') {
    let value = error;
    for (let depth = 0; depth < 4 && value && typeof value === 'object'; depth++) {
      const detail = value as {name?: unknown; code?: unknown; cause?: unknown};
      if (detail.name === 'TimeoutError') return new DownloadAttemptFailure('FFMPEG_DOWNLOAD_TIMEOUT', true);
      if (typeof detail.code === 'string' && transientNetworkCodes.has(detail.code)) return new DownloadAttemptFailure(`FFMPEG_DOWNLOAD_NETWORK_${detail.code}`, true);
      value = detail.cause;
    }
    return new DownloadAttemptFailure('FFMPEG_DOWNLOAD_NON_NETWORK_ERROR', false);
  }
  return new DownloadAttemptFailure(`FFMPEG_DOWNLOAD_${phase}_FAILED`, false);
}
async function downloadAttempt(url: string, file: string, signal: AbortSignal, request: typeof fetch): Promise<void> {
  let output: Awaited<ReturnType<typeof open>>;
  try {output = await open(file, 'wx', 0o600);}
  catch (error: unknown) {
    const exists = error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
    throw new DownloadAttemptFailure(exists ? 'FFMPEG_DOWNLOAD_FILE_EXISTS' : 'FFMPEG_DOWNLOAD_OPEN_FAILED', false);
  }
  let identity: Awaited<ReturnType<typeof output.stat>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, phase = 'STAT';
  let failure: DownloadAttemptFailure | undefined;
  try {
    identity = await output.stat(); phase = 'FETCH';
    let requestUrl = url, followed = 0;
    let response = await request(requestUrl, {redirect: 'manual', signal});
    while (redirectStatuses.has(response.status) && response.headers.has('location')) {
      const location = response.headers.get('location')!;
      await response.body?.cancel().catch(() => {});
      requestUrl = mirrorRedirect(url, location, followed++);
      if (signal.aborted) throw new DownloadAttemptFailure('FFMPEG_DOWNLOAD_TIMEOUT', true);
      response = await request(requestUrl, {redirect: 'manual', signal});
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new DownloadAttemptFailure(`FFMPEG_DOWNLOAD_HTTP_${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500 && response.status <= 599);
    }
    if (!response.body) throw new DownloadAttemptFailure('FFMPEG_DOWNLOAD_EMPTY', false);
    const advertisedBytes = Number(response.headers.get('content-length'));
    if (Number.isFinite(advertisedBytes) && advertisedBytes > maximumArchiveBytes) {
      await response.body.cancel().catch(() => {});
      throw new DownloadAttemptFailure('FFMPEG_SOURCE_TOO_LARGE', false);
    }
    reader = response.body.getReader();
    let bytes = 0;
    for (;;) {
      if (signal.aborted) throw new DownloadAttemptFailure('FFMPEG_DOWNLOAD_TIMEOUT', true);
      phase = 'STREAM'; const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumArchiveBytes) throw new DownloadAttemptFailure('FFMPEG_SOURCE_TOO_LARGE', false);
      phase = 'WRITE'; await output.writeFile(chunk.value);
    }
    if (signal.aborted) throw new DownloadAttemptFailure('FFMPEG_DOWNLOAD_TIMEOUT', true);
    if (bytes === 0) throw new DownloadAttemptFailure('FFMPEG_DOWNLOAD_EMPTY', false);
  } catch (error: unknown) {
    // A coincident timer must not turn size/ownership or local filesystem
    // failures into retryable network failures.
    failure = !(error instanceof FFmpegInstallFailure) && signal.aborted && (phase === 'FETCH' || phase === 'STREAM')
      ? new DownloadAttemptFailure('FFMPEG_DOWNLOAD_TIMEOUT', true) : downloadFailure(error, phase);
  }
  finally {
    await reader?.cancel().catch(() => {});
    if (failure) {
      try {
        // Retain the open handle while comparing identities, so inode reuse
        // cannot turn a replacement path into this attempt's partial download.
        const current = await lstat(file);
        if (!identity || !current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('Ownership changed');
        await rm(file);
      } catch {failure = new DownloadAttemptFailure('FFMPEG_DOWNLOAD_CLEANUP_FAILED', false);}
    }
    await output.close().catch(() => {failure = new DownloadAttemptFailure('FFMPEG_DOWNLOAD_CLOSE_FAILED', false);});
  }
  if (failure) throw failure;
}
export async function downloadSource(url: string, file: string, injected: Partial<DownloadServices> = {}): Promise<void> {
  const services: DownloadServices = {
    fetch, now: Date.now, pause: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    timeoutSignal: milliseconds => AbortSignal.timeout(milliseconds), diagnostic: code => {process.stderr.write(`${code}\n`);}, ...injected
  };
  const deadline = services.now() + FFMPEG_TIMEOUTS.download;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const remaining = deadline - services.now();
    if (remaining <= 0) throw new FFmpegInstallFailure('FFMPEG_DOWNLOAD_DEADLINE_EXCEEDED');
    try {await downloadAttempt(url, file, services.timeoutSignal(remaining), services.fetch); return;}
    catch (error: unknown) {
      const failure = downloadFailure(error, 'FETCH');
      services.diagnostic(failure.code);
      if (!failure.retryable || attempt === 3) throw new FFmpegInstallFailure(failure.code);
      const delay = attempt * 500;
      if (deadline - services.now() <= delay) throw new FFmpegInstallFailure('FFMPEG_DOWNLOAD_DEADLINE_EXCEEDED');
      await services.pause(delay);
    }
  }
}
function defaultTransport(): InstallTransport {
  return {
    platform: process.platform, arch: process.arch, uid: process.getuid?.(), cpuCount: availableParallelism(), download: downloadSource,
    run: (file, args, options) => new Promise<string>((resolve, reject) => {
      const child = spawn(file, [...args], {cwd: options.cwd, detached: true, env: childEnvironment(process.env), shell: false, stdio: ['ignore', 'pipe', 'pipe']});
      const chunks: Buffer[] = []; let bytes = 0, interrupted = false, stderrTail = '';
      const stop = (): void => {
        interrupted = true;
        // make spawns compiler and linker children. The detached group belongs
        // only to this invocation, so its timeout must terminate the whole group.
        if (child.pid) {try {process.kill(-child.pid, 'SIGKILL');} catch {child.kill('SIGKILL');}}
      };
      const timer = setTimeout(stop, options.timeout);
      child.stdout.on('data', (chunk: Buffer) => {bytes += chunk.length; if (bytes > 32 * 1024 * 1024) stop(); else chunks.push(chunk);});
      child.stderr.on('data', (chunk: Buffer) => {stderrTail = (stderrTail + chunk.toString('utf8')).slice(-32768);});
      child.once('error', () => {clearTimeout(timer); reject(new Error('FFmpeg build command failed'));});
      child.once('close', code => {
        clearTimeout(timer);
        const stdout = Buffer.concat(chunks).toString('utf8');
        if (code !== 0 || interrupted) {
          // Only this trusted, checksummed-source subprocess receives this log
          // path. Injected transport exceptions remain fixed codes in the caller.
          process.stderr.write(`FFmpeg ${path.basename(file)} failed (exit ${code ?? 'signal'}, interrupted=${interrupted})\n${safeBuildLog(`${stdout}\n${stderrTail}`, process.env)}\n`);
          reject(new Error('FFmpeg build command failed'));
        } else resolve(stdout);
      });
    })
  };
}
/** The source descriptor is injectable for owned transport fixtures. The CLI
 * always uses the pinned mirror of the official archive; no environment or argument overrides it. */
export async function installFFmpeg(options: InstallOptions, transport: InstallTransport = defaultTransport(), source: Source = FFMPEG_SOURCE): Promise<FFmpegInstallation> {
  if (transport.platform !== 'linux' || transport.arch !== 'x64') fail('FFMPEG_INSTALL_REQUIRES_LINUX_X64');
  if (!Number.isSafeInteger(transport.uid) || transport.uid === undefined || transport.uid <= 0) fail('FFMPEG_INSTALL_REQUIRES_NON_ROOT');
  if (!path.isAbsolute(options.runnerTemp) || /[\r\n\0]/.test(options.runnerTemp)) fail('FFMPEG_RUNNER_TEMP_REQUIRED');
  const temporaryParent = await realpath(options.runnerTemp), parentInfo = await lstat(temporaryParent);
  if (!parentInfo.isDirectory()) fail('FFMPEG_RUNNER_TEMP_REQUIRED');
  const owned = await mkdtemp(path.join(temporaryParent, `mioon-ffmpeg-${source.version}-`));
  const archive = path.join(owned, 'source.tar.xz'), directory = path.join(owned, 'source'), prefix = path.join(owned, 'install');
  let phase = 'DOWNLOAD';
  try {
    await chmod(owned, 0o700);
    await transport.download(source.url, archive);
    if (await sourceDigest(archive) !== source.sha256) fail('FFMPEG_SOURCE_SHA256_MISMATCH');
    phase = 'EXTRACT'; await mkdir(directory);
    await transport.run('tar', ['--extract', '--xz', '--strip-components=1', '--no-same-owner', '--no-same-permissions', '--file', archive, '--directory', directory], {cwd: owned, timeout: FFMPEG_TIMEOUTS.extract});
    phase = 'CONFIGURE';
    await transport.run(path.join(directory, 'configure'), configureArguments(prefix), {cwd: directory, timeout: FFMPEG_TIMEOUTS.configure});
    const jobs = buildJobs(transport.cpuCount);
    phase = 'BUILD';
    await transport.run('make', [`-j${jobs}`], {cwd: directory, timeout: FFMPEG_TIMEOUTS.build});
    phase = 'INSTALL';
    await transport.run('make', ['install'], {cwd: directory, timeout: FFMPEG_TIMEOUTS.install});
    const ffmpeg = path.join(prefix, 'bin/ffmpeg'), ffprobe = path.join(prefix, 'bin/ffprobe');
    phase = 'VERIFY';
    for (const [name, file] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) fail('FFMPEG_INSTALLED_BINARY_INVALID');
      await access(file, constants.X_OK);
      if (!(await transport.run(file, ['-version'], {cwd: prefix, timeout: FFMPEG_TIMEOUTS.version})).startsWith(`${name} version ${source.version} `)) fail('FFMPEG_INSTALLED_VERSION_MISMATCH');
    }
    phase = 'SOURCE_CLEANUP';
    await rm(directory, {recursive: true, force: true}); await rm(archive);
    const result: FFmpegInstallation = {ok: true, version: source.version, platform: 'linux', arch: 'x64', sourceSha256: source.sha256, jobs, ffmpeg, ffprobe};
    phase = 'EXPORT';
    if (options.githubPath) await appendFile(options.githubPath, `${path.dirname(ffmpeg)}\n`);
    if (options.githubEnv) await appendFile(options.githubEnv, `MIOON_FFMPEG_PATH=${ffmpeg}\nMIOON_FFPROBE_PATH=${ffprobe}\n`);
    if (options.githubSummary) await appendFile(options.githubSummary, `FFmpeg ${source.version} / Linux x64 installed from the pinned official source (SHA256 ${source.sha256}); make jobs: ${jobs}\n`);
    return result;
  } catch (error: unknown) {
    await rm(owned, {recursive: true, force: true}).catch(() => fail('FFMPEG_INSTALL_CLEANUP_FAILED'));
    if (error instanceof FFmpegInstallFailure) throw error;
    fail(`FFMPEG_${phase}_FAILED`);
  }
}
export async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (process.argv.slice(2).length > 0) fail('FFMPEG_INSTALL_TAKES_NO_ARGUMENTS');
  const result = await installFFmpeg({runnerTemp: environment.RUNNER_TEMP ?? '', githubPath: environment.GITHUB_PATH, githubEnv: environment.GITHUB_ENV, githubSummary: environment.GITHUB_STEP_SUMMARY});
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {process.stderr.write(`${error instanceof FFmpegInstallFailure ? error.code : 'FFMPEG_INSTALL_FAILED'}\n`); process.exitCode = 1;});
}
