import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access, mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export type TargetPlatform = 'linux' | 'darwin';
export type TargetArch = 'x64' | 'arm64';
export interface Check {name: string; ok: true}
export class CheckFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'CheckFailure'; this.code = code; }
}
export function fail(code: string): never { throw new CheckFailure(code); }
export function safeFailure(error: unknown): string { return error instanceof CheckFailure ? error.code : 'UNEXPECTED_CHECK_FAILURE'; }
export function argumentsFor(args: readonly string[], required: readonly string[], optional: readonly string[] = []): Record<string, string> {
  const values: Record<string, string> = {};
  for (const arg of args) {
    const match = /^--([a-z][a-z-]*)=(.+)$/.exec(arg);
    if (!match || ![...required, ...optional].includes(match[1]) || Object.hasOwn(values, match[1]) || /[\0\r\n]/.test(match[2])) fail('INVALID_ARGUMENTS');
    values[match[1]] = match[2];
  }
  if (required.some(name => !values[name])) fail('MISSING_ARGUMENTS');
  return values;
}
export function targetPlatform(value: string): TargetPlatform { if (value !== 'linux' && value !== 'darwin') fail('UNSUPPORTED_PLATFORM'); return value; }
export function targetArch(value: string): TargetArch { if (value !== 'x64' && value !== 'arm64') fail('UNSUPPORTED_ARCHITECTURE'); return value; }
export function cleanEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'SYSTEMROOT', 'WINDIR']) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}
const exec = promisify(execFile);
export async function command(file: string, args: readonly string[], code: string, options: {timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string} = {}): Promise<string> {
  const timeout = options.timeout ?? 30000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 180000) fail('INVALID_COMMAND_TIMEOUT');
  try {
    const result = await exec(file, [...args], {encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, env: options.env ?? cleanEnvironment(), cwd: options.cwd});
    return result.stdout + result.stderr;
  } catch { fail(code); }
}
export async function executable(name: string, override?: string): Promise<string> {
  const candidates = override ? [override] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, name));
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* Try the next PATH entry. */ }
  }
  fail(`MISSING_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`);
}
export async function report(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), {recursive: true});
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
}
export function isMain(moduleUrl: string): boolean { return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl); }
export function mediaCapabilities(platform: TargetPlatform, filters: string, encoders: string): {filters: Record<string, boolean>; encoders: Record<string, boolean>} {
  const requiredFilters = platform === 'linux' ? ['drawtext', 'subtitles', 'zscale', 'loudnorm', 'ebur128'] : [];
  const requiredEncoders = platform === 'linux' ? ['libx264', 'aac', 'libwebp', 'libwebp_anim'] : ['libx264', 'aac'];
  const has = (text: string, name: string): boolean => new RegExp(`^\\s*[A-Z.]{3,6}\\s+${name}\\s`, 'm').test(text);
  return {filters: Object.fromEntries(requiredFilters.map(name => [name, has(filters, name)])), encoders: Object.fromEntries(requiredEncoders.map(name => [name, has(encoders, name)]))};
}
export interface MediaCliCapabilities {filterArgumentFromFile: true; complexFilterArgumentFromFile: true; fpsModePassthrough: true; pngEncode: true; pngDecode: true}
export async function probeMediaCli(ffmpeg: string, {env = cleanEnvironment(), temporaryRoot = tmpdir(), execute = command}: {
  env?: NodeJS.ProcessEnv; temporaryRoot?: string; execute?: typeof command;
} = {}): Promise<MediaCliCapabilities> {
  const directory = await mkdtemp(path.join(await realpath(temporaryRoot), 'mioon-media-cli-'));
  try {
    const simple = path.join(directory, 'single filter.script'), complex = path.join(directory, 'complex filter.script');
    await writeFile(simple, 'null', {flag: 'wx', mode: 0o600});
    await writeFile(complex, '[0:v]null[outv]', {flag: 'wx', mode: 0o600});
    const input = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=1:d=1'];
    const output = ['-frames:v', '1', '-an', '-c:v', 'rawvideo', '-threads', '1', '-f', 'null', '-'];
    // A filter list cannot prove CLI parsing. Exercise each production option
    // independently so older distributions fail before the long media suite.
    await execute(ffmpeg, [...input, '-/filter:v', simple, ...output], 'FFMPEG_FILTER_FILE_ARGUMENT_UNSUPPORTED', {env, timeout: 10000});
    await execute(ffmpeg, [...input, '-/filter_complex', complex, '-map', '[outv]', ...output], 'FFMPEG_COMPLEX_FILTER_FILE_ARGUMENT_UNSUPPORTED', {env, timeout: 10000});
    await execute(ffmpeg, [...input, '-vf', 'null', '-fps_mode', 'passthrough', ...output], 'FFMPEG_FPS_MODE_UNSUPPORTED', {env, timeout: 10000});
    const png = path.join(directory, 'image probe.png');
    await execute(ffmpeg, [...input, '-frames:v', '1', '-an', '-c:v', 'png', '-pix_fmt', 'rgb24', '-threads', '1', '-f', 'image2', '-update', '1', '-n', png], 'FFMPEG_PNG_ENCODING_UNSUPPORTED', {env, timeout: 10000});
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', png, ...output], 'FFMPEG_PNG_DECODING_UNSUPPORTED', {env, timeout: 10000});
    return {filterArgumentFromFile: true, complexFilterArgumentFromFile: true, fpsModePassthrough: true, pngEncode: true, pngDecode: true};
  } finally { await rm(directory, {recursive: true, force: true}); }
}
export async function inspectMedia(platform: TargetPlatform): Promise<Record<string, unknown>> {
  const ffmpeg = await executable('ffmpeg', process.env.MIOON_FFMPEG_PATH), ffprobe = await executable('ffprobe', process.env.MIOON_FFPROBE_PATH);
  const version = await command(ffmpeg, ['-version'], 'FFMPEG_VERSION_FAILED');
  const probeVersion = await command(ffprobe, ['-version'], 'FFPROBE_VERSION_FAILED');
  if (!version.startsWith('ffmpeg version ') || !probeVersion.startsWith('ffprobe version ')) fail('INVALID_MEDIA_TOOL');
  const filters = await command(ffmpeg, ['-hide_banner', '-filters'], 'FFMPEG_FILTER_PROBE_FAILED');
  const encoders = await command(ffmpeg, ['-hide_banner', '-encoders'], 'FFMPEG_ENCODER_PROBE_FAILED');
  const capabilities = mediaCapabilities(platform, filters, encoders);
  if (Object.values(capabilities.filters).includes(false) || Object.values(capabilities.encoders).includes(false)) fail('REQUIRED_MEDIA_CAPABILITY_MISSING');
  const cliCapabilities = await probeMediaCli(ffmpeg);
  if (platform === 'linux' && !(await command('tar', ['--version'], 'GNU_TAR_PROBE_FAILED')).startsWith('tar (GNU tar)')) fail('GNU_TAR_REQUIRED');
  return {ok: true, platform, tools: {ffmpeg, ffprobe}, versions: {ffmpeg: version.split('\n')[0], ffprobe: probeVersion.split('\n')[0]}, capabilities, cliCapabilities, gnuTar: platform === 'linux'};
}
if (isMain(import.meta.url)) {
  let output: string | undefined;
  try {
    const args = argumentsFor(process.argv.slice(2), ['platform', 'output']); output = args.output;
    await report(output, await inspectMedia(targetPlatform(args.platform)));
  } catch (error) {
    if (output) await report(output, {ok: false, error: safeFailure(error)});
    console.error(safeFailure(error)); process.exitCode = 1;
  }
}
