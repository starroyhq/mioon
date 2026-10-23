import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {appendFile, chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {configureArguments, FFMPEG_SOURCE, installFFmpeg} from './install-ffmpeg.ts';
import {command, isMain} from './media-environment.ts';

const toolNames = ['ffmpeg', 'ffprobe'] as const;
const directoryName = 'mioon-ffmpeg-toolchain';
const keyPattern = /^ffmpeg-ubuntu-22\.04-x64-v1-[a-f0-9]{64}$/;
const maximumBinaryBytes = 128 * 1024 * 1024;
interface FileIdentity {sha256: string; bytes: number}
interface Manifest {
  schema: 1; version: string; sourceSha256: string; profileSha256: string; buildKey: string;
  files: Record<typeof toolNames[number], FileIdentity>;
}
export interface ToolchainOptions {runnerTemp: string; buildKey: string; githubPath?: string; githubEnv?: string; githubSummary?: string}
export class ToolchainFailure extends Error {
  readonly code: string;
  constructor(code: string) {super(code); this.name = 'ToolchainFailure'; this.code = code;}
}
function fail(code: string): never {throw new ToolchainFailure(code);}
function digest(value: string | Buffer): string {return createHash('sha256').update(value).digest('hex');}
function requireBuildKey(value: string): void {if (!keyPattern.test(value)) fail('FFMPEG_TOOLCHAIN_BUILD_KEY_INVALID');}
function requireLinux(): void {
  if (process.platform !== 'linux' || process.arch !== 'x64' || !process.getuid?.()) fail('FFMPEG_TOOLCHAIN_REQUIRES_LINUX_X64_NON_ROOT');
}
export function toolchainCacheKey(profileSha256: string, packages: string, operatingSystem: string): string {
  if (!/^[a-f0-9]{64}$/.test(profileSha256) || !packages.trim() ||
      !/^ID=ubuntu$/m.test(operatingSystem) || !/^VERSION_ID="?22\.04"?$/m.test(operatingSystem)) fail('FFMPEG_TOOLCHAIN_IDENTITY_INVALID');
  // Include installed library/compiler versions, not just the runner label: the
  // binaries still link to Ubuntu libraries and a runner image can change.
  return `ffmpeg-ubuntu-22.04-x64-v1-${digest(JSON.stringify({profileSha256, packages: packages.trim().split('\n').sort(), operatingSystem}))}`;
}
export async function toolchainProfile(): Promise<string> {
  const files = ['install-ffmpeg.ts', 'ffmpeg-toolchain.ts', 'media-environment.ts'];
  const sources = await Promise.all(files.map(async name => [name, await readFile(fileURLToPath(new URL(name, import.meta.url)), 'utf8')]));
  return digest(JSON.stringify({schema: 1, source: FFMPEG_SOURCE, arguments: configureArguments('<installation>'), sources}));
}
export async function currentToolchainKey(): Promise<string> {
  requireLinux();
  const [profile, packages, operatingSystem] = await Promise.all([
    toolchainProfile(), command('dpkg-query', ['-W', '-f=${binary:Package}=${Version}\n'], 'FFMPEG_TOOLCHAIN_PACKAGES_FAILED'), readFile('/etc/os-release', 'utf8')
  ]);
  return toolchainCacheKey(profile, packages, operatingSystem);
}
async function toolchainDirectory(runnerTemp: string): Promise<string> {
  if (!path.isAbsolute(runnerTemp) || /[\r\n\0]/.test(runnerTemp)) fail('FFMPEG_TOOLCHAIN_TEMP_INVALID');
  const parent = await realpath(runnerTemp);
  if (!(await lstat(parent)).isDirectory()) fail('FFMPEG_TOOLCHAIN_TEMP_INVALID');
  return path.join(parent, directoryName);
}
async function regularFile(file: string, maximumBytes: number): Promise<Awaited<ReturnType<typeof open>>> {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > maximumBytes) fail('FFMPEG_TOOLCHAIN_FILE_INVALID');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const actual = await handle.stat();
  if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size) {
    await handle.close(); fail('FFMPEG_TOOLCHAIN_FILE_CHANGED');
  }
  return handle;
}
async function binaryIdentity(file: string, executableIdentity?: FileIdentity): Promise<FileIdentity> {
  const handle = await regularFile(file, maximumBinaryBytes);
  try {
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of handle.createReadStream({autoClose: false})) {
      bytes += (chunk as Buffer).length;
      if (bytes > maximumBinaryBytes) fail('FFMPEG_TOOLCHAIN_FILE_INVALID');
      hash.update(chunk as Buffer);
    }
    const identity = {sha256: hash.digest('hex'), bytes};
    // Artifact downloads intentionally drop executable bits. Restore them only
    // after the bytes have been checked against the producer's manifest.
    if (executableIdentity) {
      if (identity.sha256 !== executableIdentity.sha256 || identity.bytes !== executableIdentity.bytes) fail('FFMPEG_TOOLCHAIN_SHA256_MISMATCH');
      await handle.chmod(0o700);
    }
    return identity;
  } finally {await handle.close();}
}
function record(value: unknown): value is Record<string, unknown> {return value !== null && typeof value === 'object' && !Array.isArray(value);}
function sameKeys(value: Record<string, unknown>, keys: string[]): boolean {return Object.keys(value).sort().join(',') === [...keys].sort().join(',');}
function parseManifest(value: unknown, buildKey: string, profileSha256: string): Manifest {
  if (!record(value) || !sameKeys(value, ['schema', 'version', 'sourceSha256', 'profileSha256', 'buildKey', 'files']) ||
      value.schema !== 1 || value.version !== FFMPEG_SOURCE.version || value.sourceSha256 !== FFMPEG_SOURCE.sha256 ||
      value.profileSha256 !== profileSha256 || value.buildKey !== buildKey || !record(value.files) || !sameKeys(value.files, [...toolNames])) fail('FFMPEG_TOOLCHAIN_MANIFEST_INVALID');
  for (const name of toolNames) {
    const file = value.files[name];
    if (!record(file) || !sameKeys(file, ['sha256', 'bytes']) || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) ||
        typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > maximumBinaryBytes) fail('FFMPEG_TOOLCHAIN_MANIFEST_INVALID');
  }
  return value as unknown as Manifest;
}
/** Store only the two tools, never the source tree, credentials or random build paths. */
export async function stageToolchain(options: ToolchainOptions, installation: {ffmpeg: string; ffprobe: string}, profileSha256: string): Promise<string> {
  requireBuildKey(options.buildKey);
  const directory = await toolchainDirectory(options.runnerTemp);
  await mkdir(directory, {mode: 0o700});
  try {
    const files = {} as Manifest['files'];
    for (const name of toolNames) {
      const identity = await binaryIdentity(installation[name]), destination = path.join(directory, name);
      await copyFile(installation[name], destination, constants.COPYFILE_EXCL);
      await chmod(destination, 0o600);
      const copied = await binaryIdentity(destination);
      if (copied.sha256 !== identity.sha256 || copied.bytes !== identity.bytes) fail('FFMPEG_TOOLCHAIN_FILE_CHANGED');
      files[name] = copied;
    }
    const manifest: Manifest = {schema: 1, version: FFMPEG_SOURCE.version, sourceSha256: FFMPEG_SOURCE.sha256, profileSha256, buildKey: options.buildKey, files};
    await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`, {flag: 'wx', mode: 0o600});
    return directory;
  } catch (error) {await rm(directory, {recursive: true, force: true}); throw error;}
}
export async function activateToolchain(options: ToolchainOptions, profileSha256: string, execute: typeof command = command): Promise<{ffmpeg: string; ffprobe: string}> {
  requireBuildKey(options.buildKey);
  const directory = await toolchainDirectory(options.runnerTemp), info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(directory)).sort().join(',') !== 'ffmpeg,ffprobe,manifest.json') fail('FFMPEG_TOOLCHAIN_DIRECTORY_INVALID');
  const handle = await regularFile(path.join(directory, 'manifest.json'), 4096);
  let manifest: Manifest;
  try {manifest = parseManifest(JSON.parse(await handle.readFile('utf8')) as unknown, options.buildKey, profileSha256);}
  catch (error) {if (error instanceof ToolchainFailure) throw error; fail('FFMPEG_TOOLCHAIN_MANIFEST_INVALID');}
  finally {await handle.close();}
  const tools = {ffmpeg: path.join(directory, 'ffmpeg'), ffprobe: path.join(directory, 'ffprobe')};
  for (const name of toolNames) {
    const actual = await binaryIdentity(tools[name]), expected = manifest.files[name];
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) fail('FFMPEG_TOOLCHAIN_SHA256_MISMATCH');
  }
  // Check all files before granting either one executable permissions.
  for (const name of toolNames) {
    await binaryIdentity(tools[name], manifest.files[name]);
    if (!(await execute(tools[name], ['-version'], 'FFMPEG_TOOLCHAIN_VERSION_FAILED', {cwd: directory})).startsWith(`${name} version ${FFMPEG_SOURCE.version} `)) fail('FFMPEG_TOOLCHAIN_VERSION_MISMATCH');
  }
  if (options.githubPath) await appendFile(options.githubPath, `${directory}\n`);
  if (options.githubEnv) await appendFile(options.githubEnv, `MIOON_FFMPEG_PATH=${tools.ffmpeg}\nMIOON_FFPROBE_PATH=${tools.ffprobe}\n`);
  if (options.githubSummary) await appendFile(options.githubSummary, `Verified FFmpeg ${FFMPEG_SOURCE.version} / Linux x64 toolchain (${options.buildKey}); required media probes run separately.\n`);
  return tools;
}
export async function main(args: readonly string[] = process.argv.slice(2), environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  requireLinux();
  if (args.length !== 1 || !['identity', 'build', 'activate'].includes(args[0] ?? '')) fail('FFMPEG_TOOLCHAIN_ARGUMENTS_INVALID');
  if (args[0] === 'identity') {
    const cacheKey = await currentToolchainKey();
    if (environment.GITHUB_OUTPUT) await appendFile(environment.GITHUB_OUTPUT, `cache_key=${cacheKey}\n`);
    process.stdout.write(`${cacheKey}\n`); return;
  }
  const options = {runnerTemp: environment.RUNNER_TEMP ?? '', buildKey: environment.MIOON_FFMPEG_BUILD_KEY ?? '', githubPath: environment.GITHUB_PATH, githubEnv: environment.GITHUB_ENV, githubSummary: environment.GITHUB_STEP_SUMMARY};
  requireBuildKey(options.buildKey);
  const profile = await toolchainProfile();
  if (args[0] === 'build') {
    if (await currentToolchainKey() !== options.buildKey) fail('FFMPEG_TOOLCHAIN_BUILD_KEY_MISMATCH');
    const installation = await installFFmpeg({runnerTemp: options.runnerTemp});
    await stageToolchain(options, installation, profile);
  } else await activateToolchain(options, profile);
}
if (isMain(import.meta.url)) main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof ToolchainFailure ? error.code : 'FFMPEG_TOOLCHAIN_FAILED'}\n`); process.exitCode = 1;
});
