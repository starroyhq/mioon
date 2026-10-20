import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, constants} from 'node:fs';
import {access, appendFile, chmod, lstat, mkdir, mkdtemp, open, realpath, rm} from 'node:fs/promises';
import {availableParallelism} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

interface Source {readonly version: string; readonly url: string; readonly sha256: string}
// Official release archive, independently checked against ffmpeg.org's signed
// .asc using release-key fingerprint FCF986EA15E6E293A5644F10B4322F04D67658D8.
export const FFMPEG_SOURCE: Source = Object.freeze({
  version: '7.1.5',
  url: 'https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz',
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
async function downloadSource(url: string, file: string): Promise<void> {
  const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(FFMPEG_TIMEOUTS.download)});
  if (!response.ok || !response.body) fail('FFMPEG_DOWNLOAD_FAILED');
  const reader = response.body.getReader(), output = await open(file, 'wx', 0o600);
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumArchiveBytes) fail('FFMPEG_SOURCE_TOO_LARGE');
      await output.writeFile(chunk.value);
    }
    if (bytes === 0) fail('FFMPEG_DOWNLOAD_EMPTY');
  } finally {await reader.cancel().catch(() => {}); await output.close();}
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
 * always uses the pinned official archive; no environment or argument overrides it. */
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
